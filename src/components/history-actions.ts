export function canSendImageToSource(item: { kind: 'image' | 'video'; videoUrl: string }): boolean {
  return item.kind === 'image' && item.videoUrl.length > 0
}
