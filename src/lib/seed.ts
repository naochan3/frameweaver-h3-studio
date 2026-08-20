/** 具体的なランダムシード値を生成する(UIのランダムボタン・初期値用) */
export function randomSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}
