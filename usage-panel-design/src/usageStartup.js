export async function loadInitialUsage(readCached, refresh) {
  const cached = await readCached();
  return cached ?? await refresh();
}
