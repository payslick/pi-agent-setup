# Vim motion extension

Project-local Pi extension that replaces the input editor with a small Vim-style modal editor.

## Vim docs checked

The implementation follows the core grammar documented in Vim help:

- `:help motion.txt` — motions, counts, `operator-motion`, `motion-count-multiplied`, doubled operators like `dd`/`yy`/`cc`, and text objects such as `iw`/`aw`.
- `:help change.txt` — delete/change/yank operator behavior.

Important Vim grammar detail: text objects are used in operator-pending mode, so the documented form is `ciw`, `diw`, `yiw`, etc. (`iwc` is not standard Vim order.) Likewise, doubled operators repeat the same operator: `y3y`, `3yy`, or `2y3y`; `y3d` is not a documented Vim command.

## Mode model

- Starts in insert mode.
- Footer status shows `- INSERT -` or `- NORMAL -`.
- Every new agent turn resets the editor to insert mode.
- Visual mode is intentionally not implemented; `v`/`V` are ignored with a footer hint.
- Single `Esc` switches to normal mode. Double `Esc` within 650ms is the interrupt/stop command while an agent turn is active.

## Supported normal-mode commands

Navigation:

- Character/line: `h` `j` `k` `l`, arrow keys, `0`, `^`, `$`
- Words: `w` `W` `b` `B` `e` `E`, `ge`, `gE`
- Lines: `gg`, `G`, `{count}G`, `{count}gg`
- Find in line: `f{char}` `F{char}` `t{char}` `T{char}`, repeat with `;` and `,`

Insert switches:

- `i` `a` `I` `A` `o` `O`

Edits/operators:

- Prompt commands: `<Space>y` copies the entire prompt to the system clipboard, `<Space>d` clears it, and `<Space>k`/`<Space>j` replace it with the previous/next history entry without clearing past the newest entry. `<Space>m` cycles the conversation between messages only, responses only, and both. After `/pr-review`, `<Space>{issue-number}<Enter>` opens a focused Herdr tab with Hunk positioned at that finding. Arrow keys only move the cursor and do not browse prompt history.
- Single-key edits: `x` `X` `D` `C`, `u`, `p`, `P`
- Operators: `d`, `y`, `c`
- Operator + motion: `db`, `d3w`, `y3w`, `c$`, `df,`, etc.
- Operator counts multiply per Vim docs: `3d2w` acts over six words; `2y3y` yanks six lines.
- Doubled line operators: `dd`, `3dd`, `y3y`, `3yy`, `cc`
- Word text objects: `diw`, `daw`, `ciw`, `caw`, `yiw`, `yaw`, plus `iW`/`aW`

## Not implemented

- Visual/visual-line/visual-block mode
- Full text-object catalog beyond word/WORD (`iw`, `aw`, `iW`, `aW`)
- Ex commands such as `:`
