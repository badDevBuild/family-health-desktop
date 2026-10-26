import { z } from 'zod';

/** 只允许技术原因、不可逆来源键和时间；不接受网址、标题、网页或患者正文。 */
export const assessmentKnowledgeRetrievalDiagnosticSchema = z.object({
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  retrievalVersion: z.enum(['official-https-content-v1', 'official-https-content-v2']),
  outcomes: z.array(z.object({
    sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['retrieved', 'failed']),
    code: z.enum(['url_not_allowed', 'dns_not_public', 'dns_unavailable', 'proxy_unavailable', 'proxy_unsupported', 'network_unavailable', 'timed_out',
      'redirect_limit', 'redirect_missing', 'http_unavailable', 'content_unsupported', 'content_too_large',
      'content_empty', 'source_limit']).nullable(),
    checkedAt: z.string().datetime()
  }).strict().refine((value) => (value.status === 'retrieved') === (value.code === null)))
    .min(1).max(64)
}).strict();

export type AssessmentKnowledgeRetrievalDiagnostic = z.infer<typeof assessmentKnowledgeRetrievalDiagnosticSchema>;
