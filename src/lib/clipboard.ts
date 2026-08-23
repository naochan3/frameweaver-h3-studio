/** クリップボードにコピー。navigator.clipboard はセキュアコンテキスト(HTTPS/localhost)限定で、
 * LAN内のIP+HTTPアクセスでは undefined になるため、execCommand フォールバックを持つ。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // セキュアでない/権限拒否 → フォールバックへ
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
