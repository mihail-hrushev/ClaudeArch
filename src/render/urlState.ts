/**
 * View settings kept in the URL, so a reload (or Vite reloading after an edit) keeps them.
 * Rewritten in place: no browser history entry per change.
 */

/** Sets `?name=value`, or removes it when `value` is null. */
export function setUrlParam(name: string, value: string | null): void {
  const params = new URLSearchParams(location.search);
  if (value === null ? !params.has(name) : params.get(name) === value) return;
  if (value === null) params.delete(name);
  else params.set(name, value);
  const query = params.toString().replace(/%2C/g, ","); // keep commas readable
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}
