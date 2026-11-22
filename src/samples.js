// samples.js — bundled practice texts.
//
// "The Night Ferry" was written for this project with AI assistance and is
// released under CC0.
//
// 「イヤホンと電車」 is a short story by the app's author, included as a
// sample with permission. It is NOT covered by the MIT licence. The text is
// unaltered; the original is a single paragraph, and here it is split into six
// paragraphs at sentence ends (．) only, so it can be marked paragraph by
// paragraph.
//
// `simPlan` tells the SIMULATED source which paragraphs to script a held
// breath on; it is never used with a real camera.

'use strict';

const NIGHT_FERRY = `The Night Ferry

For eleven years Ilse Marrow had piloted the last ferry across the Tamsk, and in eleven years nobody had ever asked her to stop in the middle of the river.

The crossing took nineteen minutes. The boat was older than she was, a flat-bottomed diesel with a cabin that smelled of rope and oranges, and on winter nights it carried mostly nurses coming off shift, a few students, and once a month a man with a cello who never spoke. The river was wide there, slow and brown, and the lights of the far bank looked closer than they were. She knew every buoy by the sound it made against the hull.

That night there was a single passenger. He came aboard at 11:52 with a canvas bag and paid in coins, counting them out onto the ledge of her window one at a time, as if each one needed to be introduced. He wore a good coat that was wet only on one side. He sat in the second row, by the window that did not open.

She cast off at midnight, as she always did. The engine settled into its low complaint. For the first few minutes there was nothing to see but the black water opening in front of the bow and the shore lights folding away behind.

Halfway across, he stood up.

"Here," he said. "Please. Stop here." He was not shouting. He said it the way you would ask someone to pass the salt, and that was what made her hands go still on the wheel. There was nothing here. There was no dock, no buoy, only the place in the middle of the river where the current turned under the boat and the water was deepest.

She told him she couldn't. She told him about the schedule and the harbour office and the insurance, and she heard her own voice getting faster. He listened politely, nodding, his bag held on his knees.

Then he asked whether she still kept the thermos of tea under the console, the green one with the dented lid, and whether she still took two sugars.

She had never seen him before in her life. She was sure of that. She looked at him properly for the first time, at his long hands and the wet sleeve of his coat, and in the dark window behind him she looked for his reflection and found only her own.

"I'm sorry," he said. "I should have explained earlier. You were always the one who brought me home."

The engine kept running. The far lights did not come any closer. Somewhere under the hull the current made its turn, the same turn it had made every night for eleven years, and she understood that she knew the exact spot, had always known it, that she slowed there every crossing without deciding to.

She pulled the throttle back. The boat drifted. The man stood, picked up his bag, and walked to the stern, and she did not turn around, because she knew that if she turned around there would be nobody there, and she knew that if she did not turn around she would hear the splash.

There was no splash.

When she docked on the far side at 12:19, the second row was empty and dry, and on the ledge of her window, counted out one at a time, were the coins.
`;

const EARPHONES = "イヤホンと電車\n\n『扉が閉まりまーす』その合図を聞いて僕の足は体をホームから車内に運ぶ．突如耳に飛び込んでくる80年代j-pop．\n\nコンビニでもあるまいし…あたりを見回しながら席を探すついでに音の発信源を横目に探す．あの男の人だ．耳にはイヤホンらしき白いプラスチック．ああ，彼にはワイヤレスイヤホンが難しかったのだと理解しながら僕は席に腰を下ろす．\n\n座るやいなや，扉の近くに男子高生が2人が立つ．ニヤつく彼ら．どうやら音楽に気づき何やら2人で話しているらしい．10秒ごとに後ろを向いて顔を突き合わせる．\n\n『君の行動は恥ずべきことだ』この一言が唇から旅立とうとしたとき僕の意識がそれを止めた．僕は彼の存在とそのミスを知り見ぬふりをしている．\n\nただ数歩歩き，声をかければ1分もせず解決できるのに．どこに彼らを咎める資格があるのだろうか．\n\n僕は目を閉じた．瞼の裏に浮かぶのは，座席に沈む僕の姿．『君の行動は，』ーー僕の唇は動かない．\n";

/** Typographic quotes for the English sample. */
function smart(t) {
    return t.replace(/(^|[\s(—])"/g, '$1\u201c').replace(/"/g, '\u201d').replace(/'/g, '\u2019');
}

module.exports = {
    samples: [
        { id: 'ferry', label: 'The Night Ferry (sample, English)', text: smart(NIGHT_FERRY), simPlan: { beats: [5, 8, 11], away: 7 } },
        { id: 'earphones', label: 'イヤホンと電車（縦書き）', text: EARPHONES, vertical: true, simPlan: { beats: [3, 5], away: -1 } },
    ],
};
