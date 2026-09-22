/** 旧版建议与新版行动只有稳定键和身体范围都一致时才视为同一方向。 */
export function sameAdoptedActionScope(
  legacy: { dedupeKey: string; relatedSystemIds: string[] },
  current: { dedupeKey: string; systemIds: string[] }
): boolean {
  if (!legacy.dedupeKey || legacy.dedupeKey.startsWith('legacy:')
    || legacy.dedupeKey !== current.dedupeKey) return false;
  return legacy.relatedSystemIds.some((systemId) => current.systemIds.includes(systemId));
}
