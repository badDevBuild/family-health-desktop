export interface CodexTurnFailureDetails {
  code: string;
  modelBusy: boolean;
  safeReason: string;
  threadId?: string;
  turnId?: string;
  serviceCode?: string;
  httpStatus?: number;
}

type TurnFailureReceipt = Pick<CodexTurnFailureDetails, 'code'> &
  Partial<Pick<CodexTurnFailureDetails, 'threadId' | 'turnId' | 'serviceCode' | 'httpStatus'>>;

const safeServiceCodes = new Set([
  'server_overloaded', 'serverOverloaded', 'model_at_capacity', 'model_capacity_exceeded',
  'invalid_json_schema', 'context_window_exceeded', 'insufficient_quota', 'quota_exceeded',
  'usage_limit_exceeded', 'usage_limit_reached', 'credit_balance_exhausted',
  'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
  'rate_limit_exceeded', 'slow_down', 'invalid_api_key', 'authentication_error', 'permission_denied',
  'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'
]);

const quotaTags = new Set([
  'insufficientquota', 'quotaexceeded', 'usagelimitexceeded', 'usagelimitreached',
  'creditbalanceexhausted', 'organizationspendlimitexceeded', 'projectspendlimitexceeded',
  'organizationusagelimitexceeded'
]);
const rateLimitTags = new Set(['ratelimitexceeded', 'slowdown']);
// 采用运行时的结构化连接分类；重试通知的 message 可能只有 Reconnecting，不能依赖自由文案。
const connectionFailureTags = new Set(['httpconnectionfailed', 'responsestreamconnectionfailed',
  'responsestreamdisconnected', 'responsetoomanyfailedattempts']);
const permanentFailureTags = new Set([
  'invalidapikey', 'authenticationerror', 'permissiondenied', 'authrequired', 'unauthorized',
  'badrequest', 'cyberpolicy', 'sessionbudgetexceeded'
]);
const permanentHttpStatuses = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422]);

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
    ? value : undefined;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value : undefined;
}

function safeFailureCode(value: string): string {
  return /^CODEX_[A-Z_]{1,80}$/.test(value) ? value : 'CODEX_TURN_FAILED';
}

function safeReasonForCode(code: string): string {
  if (code === 'CODEX_MODEL_BUSY') return '所选模型暂时繁忙，已完成的报告和结果不受影响。';
  if (code === 'CODEX_QUOTA_EXHAUSTED') return '服务已明确返回额度或用量已达上限，已完成的报告和结果不受影响。';
  if (code === 'CODEX_RATE_LIMITED') return '服务已明确返回短期限流，已完成的报告和结果不受影响。';
  if (code === 'CODEX_REQUEST_LIMITED_UNKNOWN') return '服务限制了本次请求，但未说明是额度还是短期限流；已完成的报告和结果不受影响。';
  if (code === 'CODEX_CONTEXT_WINDOW_EXCEEDED') return '本次输入超过模型可处理的范围。';
  if (code === 'CODEX_OUTPUT_SCHEMA_INVALID') return '本次结构化输出要求暂时无法被服务接受。';
  if (code === 'CODEX_CONNECTION_FAILED') return '模型连接中断，自动恢复未成功。已完成的报告和结果保留；可从未完成的步骤继续。';
  if (code === 'CODEX_START_STATE_UNKNOWN' || code === 'RUNTIME_RECOVERY_INPUT_CHANGED') return '模型请求可能已经启动，但暂时无法核实回应。应用已保留断点并停止重复发送；已有结果保留。';
  if (code === 'CODEX_START_RECOVERY_EXHAUSTED') return '模型会话启动多次未取得回应，已停止自动尝试。已有报告和结果保留。';
  if (code === 'CODEX_RPC_TIMEOUT:thread/start') return '模型会话启动回应超时，尚未确认本次读取已开始。已有结果保留，可从这个步骤恢复。';
  if (code === 'CODEX_RPC_TIMEOUT:turn/start') return '模型处理的启动回应未及时返回，应用会先核实原请求，避免重复发送资料。已有结果保留。';
  if (code === 'CODEX_TURN_INTERRUPTED') return '本次模型处理已中断。';
  return '本次模型处理未能完成，已完成的报告和结果不受影响。';
}

// 仅携带固定原因与有限回执；不保留可能包含报告正文、路径或令牌的原始服务错误。
export class CodexTurnFailure extends Error {
  readonly details: Readonly<CodexTurnFailureDetails>;

  constructor(receipt: TurnFailureReceipt) {
    const code = safeFailureCode(receipt.code);
    super(code);
    this.name = 'CodexTurnFailure';
    const threadId = safeIdentifier(receipt.threadId);
    const turnId = safeIdentifier(receipt.turnId);
    const serviceCode = typeof receipt.serviceCode === 'string' && safeServiceCodes.has(receipt.serviceCode)
      ? receipt.serviceCode : undefined;
    const httpStatus = safeHttpStatus(receipt.httpStatus);
    this.details = Object.freeze({
      code, modelBusy: code === 'CODEX_MODEL_BUSY', safeReason: safeReasonForCode(code),
      ...(threadId === undefined ? {} : { threadId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(serviceCode === undefined ? {} : { serviceCode }),
      ...(httpStatus === undefined ? {} : { httpStatus })
    });
  }
}

export function getCodexTurnFailureDetails(error: unknown): CodexTurnFailureDetails | null {
  if (error instanceof CodexTurnFailure) return { ...error.details };
  const startupCodes = new Set(['CODEX_START_STATE_UNKNOWN', 'RUNTIME_RECOVERY_INPUT_CHANGED',
    'CODEX_START_RECOVERY_EXHAUSTED', 'CODEX_RPC_TIMEOUT:thread/start', 'CODEX_RPC_TIMEOUT:turn/start']);
  if (error instanceof Error && startupCodes.has(error.message)) return {
    code: error.message, modelBusy: false, safeReason: safeReasonForCode(error.message)
  };
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function normalizedTag(value: string): string {
  return value.replace(/[_-]/g, '').toLowerCase();
}

export function createCodexTurnFailure(input: {
  threadId: string;
  turnId: string;
  status: string;
  error: unknown;
}): CodexTurnFailure {
  const outer = recordValue(input.error);
  const detail = recordValue(outer?.error) ?? outer;
  const serviceCode = typeof detail?.code === 'string' ? detail.code : '';
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const infoObject = recordValue(detail?.codexErrorInfo);
  const infoKeys = Object.keys(infoObject ?? {});
  const infoTag = typeof detail?.codexErrorInfo === 'string'
    ? detail.codexErrorInfo : infoKeys.length === 1 ? infoKeys[0]! : '';
  const infoPayload = recordValue(infoObject?.[infoTag]);
  const httpStatus = safeHttpStatus(detail?.httpStatusCode) ?? safeHttpStatus(detail?.httpStatus)
    ?? safeHttpStatus(infoPayload?.httpStatusCode) ?? safeHttpStatus(infoPayload?.httpStatus);
  const tags = [normalizedTag(serviceCode), normalizedTag(infoTag)];
  let code = /^\w+$/.test(input.status) ? `CODEX_TURN_${input.status.toUpperCase()}` : 'CODEX_TURN_FAILED';

  // 上下文、契约、账户及连接问题不能因错误中出现“繁忙”字样而触发容量重试。
  if (tags.includes('enospc') || tags.includes('sqlitefull')
    || /\bENOSPC\b|\bSQLITE_FULL\b|\bno space left on device\b/i.test(message)) {
    // 服务回执里的磁盘错误不证明本机已满，但同样不能当作模型繁忙自动重发。
  } else if (tags.includes('contextwindowexceeded') || /context.window.exceeded/i.test(message)) {
    code = 'CODEX_CONTEXT_WINDOW_EXCEEDED';
  } else if (serviceCode === 'invalid_json_schema' || message.includes('Invalid schema for response_format')) {
    code = 'CODEX_OUTPUT_SCHEMA_INVALID';
  } else if ((httpStatus !== undefined && permanentHttpStatuses.has(httpStatus))
    || tags.some((tag) => permanentFailureTags.has(tag))) {
    // 明确的认证、权限或永久请求错误不能因附带“繁忙”文字被自动重试。
  } else if (input.status === 'failed' && tags.some((tag) => quotaTags.has(tag))) {
    code = 'CODEX_QUOTA_EXHAUSTED';
  } else if (input.status === 'failed' && tags.some((tag) => rateLimitTags.has(tag))) {
    code = 'CODEX_RATE_LIMITED';
  } else if (input.status === 'failed' && httpStatus === 429) {
    // 429 同时可能代表额度或短期限流；没有结构化原因时不能猜成繁忙或自动重试。
    code = 'CODEX_REQUEST_LIMITED_UNKNOWN';
  } else if (tags.some((tag) => quotaTags.has(tag) || rateLimitTags.has(tag))
    || /(?:invalid api key|authentication required|unauthorized|insufficient quota|quota exceeded|exceeded your current quota|usage limit|rate.?limit)/i.test(message)) {
    // 非失败终态或只有自由文本线索时保留原状态；自由文本不构成新的额度/限流证据。
  } else if (tags.some((tag) => connectionFailureTags.has(tag))
    || /connection reset|failed to connect|stream disconnected/i.test(message)) {
    code = 'CODEX_CONNECTION_FAILED';
  } else if (input.status === 'failed' && (tags.some((tag) => /^(?:serveroverloaded|modelatcapacity|modelcapacityexceeded)$/.test(tag))
    || /\bselected model is at capacity\b|\bmodel (?:is )?(?:currently )?at capacity\b|\bserver (?:is )?(?:currently )?overloaded\b/i.test(message))) {
    code = 'CODEX_MODEL_BUSY';
  }
  return new CodexTurnFailure({
    code, threadId: input.threadId, turnId: input.turnId,
    ...(serviceCode ? { serviceCode } : safeServiceCodes.has(infoTag) ? { serviceCode: infoTag } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus })
  });
}
