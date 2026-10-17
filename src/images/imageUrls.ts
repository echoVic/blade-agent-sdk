export function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
