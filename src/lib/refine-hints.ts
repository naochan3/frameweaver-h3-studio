/** 「日本語で修正」で足せる代表的な"軸"のヒント。
 * 0→1のAI案に対して、人間がどの方向を調整できるかを見える化する(レビューの天井を作らないため)。
 * クリックすると修正欄にこの日本語が入る(そのまま編集して反映できる)。 */
export interface RefineHint {
  label: string
  phrase: string
}

/** 画像・動画で共通に使える調整軸(時間帯 / カメラ / 光と影 / 構図・演出 / 動き / ムード) */
export const REFINE_HINTS: RefineHint[] = [
  { label: '夕焼け', phrase: '夕焼けの時間帯にして、影を長く柔らかく' },
  { label: '朝の光', phrase: '朝の澄んだ柔らかい光にして' },
  { label: '夜・ネオン', phrase: '夜にしてネオンや街明かりで照らす' },
  { label: 'ローアングル', phrase: 'ローアングルから見上げる構図で' },
  { label: '俯瞰', phrase: '俯瞰(ハイアングル)の構図で' },
  { label: '顔に寄る', phrase: '顔にぐっと寄ったクローズアップで' },
  { label: '引き・全身', phrase: '引きの構図で全身が入るように' },
  { label: '逆光', phrase: '逆光にしてリムライトと長い影を出す' },
  { label: '背景ぼかし', phrase: '背景を大きくぼかして被写体を際立たせる' },
  { label: '動きを大きく', phrase: '動きをもっと大きく躍動的に、髪や布をなびかせる' },
  { label: 'シネマティック', phrase: '全体を映画的でシネマティックな雰囲気に' },
  { label: '明るく元気', phrase: 'ムードを明るく元気で爽やかに' },
]

/** 既存の指示に軸フレーズを追記する(重複は避ける) */
export function appendHint(current: string, phrase: string): string {
  const cur = current.trim()
  if (cur.includes(phrase)) return cur
  return cur ? `${cur.replace(/[、,]\s*$/, '')}、${phrase}` : phrase
}
