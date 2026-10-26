import { describe, expect, it } from 'vitest';
import { CodexTurnFailure, createCodexTurnFailure, getCodexTurnFailureDetails } from './codex-turn-failure.js';

function failure(error: unknown, status = 'failed') {
  return createCodexTurnFailure({ threadId: 'thread-fixture', turnId: 'turn-fixture', status, error });
}

describe('CodexTurnFailure', () => {
  it.each(['CODEX_START_STATE_UNKNOWN', 'RUNTIME_RECOVERY_INPUT_CHANGED', 'CODEX_START_RECOVERY_EXHAUSTED',
    'CODEX_RPC_TIMEOUT:thread/start', 'CODEX_RPC_TIMEOUT:turn/start'])('启动恢复原因 %s 不误报为模型繁忙，也不显示原始诊断', (code) => {
    const details = getCodexTurnFailureDetails(new Error(code));
    expect(details).toMatchObject({ code, modelBusy: false });
    expect(details?.safeReason).toContain('已有');
    expect(details?.safeReason).not.toContain(code);
    expect(getCodexTurnFailureDetails(new Error(`${code}: 合成私人正文`))).toBeNull();
  });
  it.each(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts'])('结构化 %s 不依赖重连提示文案，且不盖过认证或额度', (tag) => {
    const error = { message: 'Reconnecting... 1/5', codexErrorInfo: { [tag]: { httpStatusCode: null } } };
    expect(failure(error).details.code).toBe('CODEX_CONNECTION_FAILED');
    expect(failure({ ...error, httpStatusCode: 401 }).details.code).toBe('CODEX_TURN_FAILED');
    expect(failure({ ...error, httpStatusCode: 429 }).details.code).toBe('CODEX_REQUEST_LIMITED_UNKNOWN');
    expect(failure({ ...error, code: 'insufficient_quota' }).details.code).toBe('CODEX_QUOTA_EXHAUSTED');
  });
  it.each([
    { message: 'Selected model is at capacity. Please try again later.' },
    { codexErrorInfo: 'ServerOverloaded', message: 'Please try again later.' },
    { codexErrorInfo: { serverOverloaded: { httpStatusCode: 503 } }, message: 'Please try again later.' },
    { code: 'model_capacity_exceeded', message: 'Please try again later.' },
    { code: 'server_overloaded', message: 'Please try again later.' }
  ])('仅明确模型容量不足保留为可重试分类 %#', (error) => {
    const result = failure({ error });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('CODEX_MODEL_BUSY');
    expect(getCodexTurnFailureDetails(result)).toMatchObject({
      code: 'CODEX_MODEL_BUSY', modelBusy: true, threadId: 'thread-fixture', turnId: 'turn-fixture',
      safeReason: '所选模型暂时繁忙，已完成的报告和结果不受影响。'
    });
  });

  it.each([
    { message: 'Service unavailable', httpStatusCode: 503 },
    { message: 'Storage is at capacity' },
    { code: 'ENOSPC', message: 'Selected model is at capacity' },
    { code: 'SQLITE_FULL', message: 'Server is overloaded' },
    { message: 'ENOSPC: no space left on device; selected model is at capacity' },
    { message: 'Unknown service failure' },
    { code: 'authentication_error', message: 'Selected model is at capacity' },
    { message: 'Selected model is at capacity', httpStatusCode: 401 },
    { message: 'Selected model is at capacity', httpStatusCode: 403 },
    { message: 'rate limit reached; selected model is at capacity' },
    { message: 'quota exceeded; selected model is at capacity' },
    { message: 'usage limit reached; selected model is at capacity' },
    { codexErrorInfo: 'SessionBudgetExceeded', message: 'Selected model is at capacity' },
    { codexErrorInfo: 'BadRequest', message: 'Selected model is at capacity' },
    { code: 'permission_denied', message: 'Server is overloaded' },
    { message: 'Selected model is at capacity', httpStatusCode: 400 },
    { code: 'rate_limit_exceeded', httpStatusCode: 403, message: 'Selected model is at capacity' },
    { codexErrorInfo: 'Unauthorized', code: 'insufficient_quota', message: 'Server is overloaded' }
  ])('永久错误或仅自由文本线索不能冒充模型繁忙或结构化额度原因 %#', (error) => {
    expect(failure(error).message).toBe('CODEX_TURN_FAILED');
    expect(getCodexTurnFailureDetails(failure(error))?.modelBusy).toBe(false);
  });

  it.each([
    { code: 'insufficient_quota', message: 'Selected model is at capacity' },
    { code: 'quota_exceeded', httpStatusCode: 429, message: 'Server is overloaded' },
    { code: 'usage_limit_exceeded', message: 'Please try later' },
    { code: 'usage_limit_reached', message: 'Please try later' },
    { code: 'credit_balance_exhausted', message: 'Please try later' },
    { code: 'organization_spend_limit_exceeded', message: 'Please try later' },
    { code: 'project_spend_limit_exceeded', message: 'Please try later' },
    { code: 'organization_usage_limit_exceeded', message: 'Please try later' },
    { codexErrorInfo: 'UsageLimitExceeded', message: 'Selected model is at capacity' },
    { codexErrorInfo: 'usageLimitExceeded', message: 'Service unavailable', additionalDetails: null },
    { codexErrorInfo: { usageLimitExceeded: null }, message: 'Service unavailable' },
    { code: 'rate_limit_exceeded', codexErrorInfo: 'UsageLimitExceeded', message: 'Server is overloaded' }
  ])('仅明确额度或用量代码分类为额度不足，优先于繁忙或限流文字 %#', (error) => {
    const result = failure({ error });
    expect(result.message).toBe('CODEX_QUOTA_EXHAUSTED');
    expect(result.details).toMatchObject({ code: 'CODEX_QUOTA_EXHAUSTED', modelBusy: false,
      safeReason: '服务已明确返回额度或用量已达上限，已完成的报告和结果不受影响。' });
  });

  it.each([
    { code: 'rate_limit_exceeded', message: 'Selected model is at capacity' },
    { code: 'slow_down', httpStatusCode: 429, message: 'Too many requests' },
    { codexErrorInfo: 'RateLimitExceeded', message: 'Server is overloaded' },
    { codexErrorInfo: { rateLimitExceeded: { httpStatusCode: 429 } }, message: 'Please try later' }
  ])('明确短期限流单独分类，但不启用繁忙重试 %#', (error) => {
    const result = failure(error);
    expect(result.message).toBe('CODEX_RATE_LIMITED');
    expect(result.details).toMatchObject({ code: 'CODEX_RATE_LIMITED', modelBusy: false,
      safeReason: '服务已明确返回短期限流，已完成的报告和结果不受影响。' });
  });

  it.each([
    { message: 'Too many requests', httpStatusCode: 429 },
    { message: 'Selected model is at capacity', httpStatus: 429 },
    { code: 'server_overloaded', httpStatusCode: 429, message: 'Server is overloaded' },
    { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, message: 'Stream failed', additionalDetails: null },
    { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } }, message: 'stream disconnected' },
    { codexErrorInfo: { httpConnectionFailed: { httpStatus: 429 } }, message: 'failed to connect' },
    { message: 'Quota exceeded; rate limit reached', httpStatusCode: 429 }
  ])('单独 HTTP 429 不猜额度或短期限流，也不归为模型繁忙 %#', (error) => {
    const result = failure({ error });
    expect(result.details).toMatchObject({ code: 'CODEX_REQUEST_LIMITED_UNKNOWN', modelBusy: false,
      httpStatus: 429,
      safeReason: '服务限制了本次请求，但未说明是额度还是短期限流；已完成的报告和结果不受影响。' });
  });

  it.each([
    [{ codexErrorInfo: 'ContextWindowExceeded', message: 'Selected model is at capacity' }, 'CODEX_CONTEXT_WINDOW_EXCEEDED'],
    [{ codexErrorInfo: { contextWindowExceeded: null }, message: 'Selected model is at capacity' }, 'CODEX_CONTEXT_WINDOW_EXCEEDED'],
    [{ code: 'invalid_json_schema', message: 'Selected model is at capacity' }, 'CODEX_OUTPUT_SCHEMA_INVALID'],
    [{ message: 'Invalid schema for response_format; Selected model is at capacity' }, 'CODEX_OUTPUT_SCHEMA_INVALID'],
    [{ code: 'insufficient_quota', codexErrorInfo: 'ContextWindowExceeded', httpStatusCode: 429 }, 'CODEX_CONTEXT_WINDOW_EXCEEDED'],
    [{ code: 'invalid_json_schema', codexErrorInfo: 'UsageLimitExceeded', httpStatusCode: 429 }, 'CODEX_OUTPUT_SCHEMA_INVALID'],
    [{ message: 'stream disconnected; Selected model is at capacity' }, 'CODEX_CONNECTION_FAILED']
  ])('已有明确失败码优先于繁忙文字 %#', (error, expected) => {
    expect(failure(error).message).toBe(expected);
  });

  it('只保存允许的服务元数据，不保留原始错误、报告、路径或凭证', () => {
    const result = failure({ error: {
      code: 'server_overloaded', httpStatusCode: 503,
      message: 'Selected model is at capacity: 合成私人正文 /isolated/private.txt sk-test-only',
      unsafeExtra: '合成私人字段'
    } });
    expect(getCodexTurnFailureDetails(result)).toMatchObject({ serviceCode: 'server_overloaded', httpStatus: 503 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/合成私人|private\.txt|sk-test-only|unsafeExtra/);
    expect(result).not.toHaveProperty('cause');
    expect(failure({ code: 'arbitrary_private_identifier', message: 'Selected model is at capacity' }).details)
      .not.toHaveProperty('serviceCode');
  });

  it.each([
    ['insufficient_quota', 'CODEX_QUOTA_EXHAUSTED'],
    ['rate_limit_exceeded', 'CODEX_RATE_LIMITED'],
    ['arbitrary_private_identifier', 'CODEX_REQUEST_LIMITED_UNKNOWN']
  ])('新额度分类同样只保留固定原因和白名单服务码 %s', (code, expected) => {
    const result = failure({ error: { code, httpStatusCode: 429,
      message: '合成私密正文 /isolated/private-report.txt sk-synthetic-token; selected model is at capacity',
      additionalDetails: '合成私密附注', requestId: '合成私密编号' } });
    expect(result.message).toBe(expected);
    expect(result.details.modelBusy).toBe(false);
    expect(result.details.httpStatus).toBe(429);
    expect(JSON.stringify(result)).not.toMatch(/合成私密|private-report|sk-synthetic|additionalDetails|requestId/);
    expect(result).not.toHaveProperty('cause');
    if (code === 'arbitrary_private_identifier') expect(result.details).not.toHaveProperty('serviceCode');
    else expect(result.details.serviceCode).toBe(code);
  });

  it('不把附加文本或无效结构中的限制标签当作结构化原因', () => {
    expect(failure({ message: 'Service failed', additionalDetails: '{"code":"insufficient_quota"}' }).message)
      .toBe('CODEX_TURN_FAILED');
    expect(failure({ codexErrorInfo: { usageLimitExceeded: null, rateLimitExceeded: null } }).message)
      .toBe('CODEX_TURN_FAILED');
    expect(failure({ codexErrorInfo: ['UsageLimitExceeded'] }).message).toBe('CODEX_TURN_FAILED');
    expect(failure({ code: 'insufficient_quota-private-token', httpStatusCode: '429' }).details)
      .toMatchObject({ code: 'CODEX_TURN_FAILED', modelBusy: false });
  });

  it('构造器拒绝不安全回执，并不接受外部原因作为可展示文案', () => {
    const result = new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY', threadId: '/private/report',
      turnId: 'unsafe turn', serviceCode: 'secret-token', httpStatus: 12 });
    expect(result.details).toEqual({ code: 'CODEX_MODEL_BUSY', modelBusy: true,
      safeReason: '所选模型暂时繁忙，已完成的报告和结果不受影响。' });
    expect(getCodexTurnFailureDetails(new Error('CODEX_MODEL_BUSY'))).toBeNull();
    expect(getCodexTurnFailureDetails(null)).toBeNull();
  });

  it('返回独立详情副本，不能通过取出的对象改写错误分类', () => {
    const result = failure({ message: 'Selected model is at capacity' });
    const details = getCodexTurnFailureDetails(result)!;
    details.code = 'CODEX_TURN_FAILED';
    expect(result.details.code).toBe('CODEX_MODEL_BUSY');
    expect(failure(null, 'interrupted').message).toBe('CODEX_TURN_INTERRUPTED');
  });

  it('中断或取消状态不能因附带容量错误被自动恢复', () => {
    expect(failure({ message: 'Selected model is at capacity' }, 'interrupted').message).toBe('CODEX_TURN_INTERRUPTED');
    expect(failure({ codexErrorInfo: 'ServerOverloaded' }, 'cancelled').details.modelBusy).toBe(false);
    expect(failure({ codexErrorInfo: 'UsageLimitExceeded', httpStatusCode: 429 }, 'interrupted').message)
      .toBe('CODEX_TURN_INTERRUPTED');
    expect(failure({ code: 'rate_limit_exceeded', httpStatusCode: 429 }, 'cancelled').message)
      .toBe('CODEX_TURN_CANCELLED');
    expect(failure({ message: 'Selected model is at capacity', httpStatusCode: 429 }, 'interrupted').message)
      .toBe('CODEX_TURN_INTERRUPTED');
  });
});
