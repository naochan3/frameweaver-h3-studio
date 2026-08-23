/** 「日本語で修正」で足せる調整"軸"のヒント(カテゴリ別)。
 * 0→1のAI案に対して、人間がどの方向を調整できるかを網羅的に見える化する
 * (レビューの天井を作らないため)。クリックで修正欄に日本語が入り、編集して反映できる。 */
export interface RefineHint {
  label: string
  phrase: string
}

export interface RefineHintGroup {
  category: string
  hints: RefineHint[]
}

/** 画像・動画で共通に使える調整軸 */
export const REFINE_HINT_GROUPS: RefineHintGroup[] = [
  {
    category: '時間帯',
    hints: [
      { label: '朝', phrase: '朝の澄んだ柔らかい光にして' },
      { label: '昼', phrase: '真昼の明るい順光にして' },
      { label: '夕焼け', phrase: '夕焼けの時間帯にして、影を長く柔らかく' },
      { label: '夜・ネオン', phrase: '夜にしてネオンや街明かりで照らす' },
    ],
  },
  {
    category: '光と影',
    hints: [
      { label: '逆光', phrase: '逆光にしてリムライトと長い影を出す' },
      { label: '柔らかい光', phrase: '曇り空のような柔らかく均一な光にする' },
      { label: '強い陰影', phrase: 'コントラストの強い硬い光でくっきりした影に' },
      { label: 'スタジオ照明', phrase: 'スタジオのライティングでクリーンに照らす' },
    ],
  },
  {
    category: 'カメラ',
    hints: [
      { label: 'ローアングル', phrase: 'ローアングルから見上げる構図で' },
      { label: '俯瞰', phrase: '俯瞰(ハイアングル)の構図で' },
      { label: '顔に寄る', phrase: '顔にぐっと寄ったクローズアップで' },
      { label: '引き・全身', phrase: '引きの構図で全身が入るように' },
    ],
  },
  {
    category: 'レンズ',
    hints: [
      { label: '望遠85mm', phrase: '85mm望遠レンズで背景を圧縮しボケを大きく' },
      { label: '広角', phrase: '広角レンズでダイナミックな遠近感に' },
      { label: 'マクロ', phrase: 'マクロで細部の質感まで写す' },
      { label: '被写界深度浅め', phrase: '被写界深度を浅くして背景を大きくぼかす' },
    ],
  },
  {
    category: '構図',
    hints: [
      { label: '三分割', phrase: '三分割構図で被写体を置く' },
      { label: '中央', phrase: '被写体を中央に据えた日の丸構図で' },
      { label: '背景ぼかし', phrase: '背景を大きくぼかして被写体を際立たせる' },
      { label: '余白広め', phrase: '余白を広く取った抜け感のある構図で' },
    ],
  },
  {
    category: '色調',
    hints: [
      { label: '暖色', phrase: '全体を暖色系の色味に' },
      { label: '寒色', phrase: '全体を寒色系でクールな色味に' },
      { label: '鮮やか', phrase: '彩度を上げて鮮やかで発色の良い色に' },
      { label: 'くすみ', phrase: 'くすんだ落ち着いたトーンに' },
    ],
  },
  {
    category: '質感',
    hints: [
      { label: 'フィルム感', phrase: 'フィルム写真の質感と粒状感を足す' },
      { label: 'ヴィンテージ', phrase: '色褪せたヴィンテージな雰囲気に' },
      { label: '肌をリアルに', phrase: '肌の質感をリアルに(毛穴・産毛・微細な質感)' },
      { label: 'つや・濡れ', phrase: 'しっとりしたつや・濡れた質感を強調' },
    ],
  },
  {
    category: '動き・ムード',
    hints: [
      { label: '動きを大きく', phrase: '動きをもっと大きく躍動的に、髪や布をなびかせる' },
      { label: 'シネマティック', phrase: '全体を映画的でシネマティックな雰囲気に' },
      { label: 'ドラマチック', phrase: 'ドラマチックで緊張感のある空気に' },
      { label: '明るく元気', phrase: 'ムードを明るく元気で爽やかに' },
    ],
  },
]

/** 既存の指示に軸フレーズを追記する(重複は避ける) */
export function appendHint(current: string, phrase: string): string {
  const cur = current.trim()
  if (cur.includes(phrase)) return cur
  return cur ? `${cur.replace(/[、,]\s*$/, '')}、${phrase}` : phrase
}
