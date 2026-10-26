// 整篇报告持续输出时不按固定墙钟截断；连续无真实进展才触发此超时。
export const HEALTH_MODEL_TURN_TIMEOUT_MS = 30 * 60_000;
// 进展也不能无限延长任务，绝对上限同时约束所有模型轮次。
export const HEALTH_MODEL_TURN_MAX_DURATION_MS = 2 * 60 * 60_000;
// 仅在服务已明确报告连接中断后计时；长报告正常推理不使用这个较短窗口。
export const HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS = 5 * 60_000;
export const HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT = 8;
// 启动 RPC 软超时后只等待同一请求的回执/已开始事件，不重发健康资料。
export const HEALTH_STARTUP_RECEIPT_GRACE_MS = 60_000;
