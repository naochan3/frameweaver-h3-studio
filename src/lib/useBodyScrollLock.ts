import { useEffect } from 'react'

/** モーダル表示中は背景(body)のスクロールを固定する。
 * active が true の間だけロックし、解除時に元へ戻す。多重ロックにも対応(カウンタ方式)。 */
let lockCount = 0

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    lockCount += 1
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      lockCount -= 1
      if (lockCount <= 0) {
        document.body.style.overflow = prev || ''
        lockCount = 0
      }
    }
  }, [active])
}
