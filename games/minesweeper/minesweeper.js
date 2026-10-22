/* ============================================================
   minesweeper.js — 扫雷（逻辑层）
   9x9 / 10 雷；左键(点按)翻开，右键(长按)插旗；首页安全
   计分用的是"用时"，所以走 lowerIsBetter + 只在通关时记录最快
   ============================================================ */
(function () {
    'use strict';

    var N = 9, MINES = 10, CELL = 40;
    var W = N * CELL, H = N * CELL;          // 360 x 360

    /* 配色分三层，靠"凸起 / 凹陷"拉开对比：
       未翻开 = 亮面 + 上高光下暗边（浮起来）
       已翻开 = 比画布底色更暗的下沉面（挖下去）
       两者亮度差约 20 个百分点，远看也能一眼分清 */
    var COL = {
        bg:         '#16213e',
        closedTop:  '#3d5080',      // 未开格：上缘亮
        closedBot:  '#252f4d',      // 未开格：下缘暗
        closedLine: 'rgba(0,0,0,0.45)',
        closedHi:   'rgba(255,255,255,0.22)',
        openFace:   '#0a1120',      // 已开格：挖开的深色
        openEdge:   'rgba(0,0,0,0.55)',
        boom:       '#e94560'
    };

    var NUM_COLORS = {
        1: '#4dd2ff', 2: '#3ddc84', 3: '#ff6b81', 4: '#b388ff',
        5: '#ffb74d', 6: '#4dd0e1', 7: '#e8ecf5', 8: '#9aa7b8'
    };

    var mine = [], open = [], flag = [];
    var planted = false, dead = false, won = false;
    var t0 = 0, elapsed = 0;
    var shell = null;

    var idx = function (r, c) { return r * N + c; };

    function neighbors(r, c) {
        var out = [];
        for (var dr = -1; dr <= 1; dr++) {
            for (var dc = -1; dc <= 1; dc++) {
                if (!dr && !dc) continue;
                var rr = r + dr, cc = c + dc;
                if (rr >= 0 && rr < N && cc >= 0 && cc < N) out.push(idx(rr, cc));
            }
        }
        return out;
    }

    function reset() {
        mine = []; open = []; flag = [];
        for (var i = 0; i < N * N; i++) { mine.push(false); open.push(false); flag.push(false); }
        planted = false; dead = false; won = false;
        stopClock();
        t0 = 0; elapsed = 0;
    }

    /* 首点安全：首点及其 8 邻域都不布雷 */
    function placeMines(sr, sc) {
        var banned = {};
        banned[idx(sr, sc)] = true;
        neighbors(sr, sc).forEach(function (i) { banned[i] = true; });

        var pool = [];
        for (var i = 0; i < N * N; i++) if (!banned[i]) pool.push(i);

        for (var placed = 0; placed < MINES && pool.length; placed++) {
            var k = Math.floor(Math.random() * pool.length);
            mine[pool[k]] = true;
            pool.splice(k, 1);
        }
    }

    function adjCount(r, c) {
        return neighbors(r, c).filter(function (i) { return mine[i]; }).length;
    }

    /* 展开：数字为 0 的格子向外扩散（迭代栈，避免深递归） */
    function revealFrom(r, c) {
        var stack = [[r, c]];
        while (stack.length) {
            var p = stack.pop(), pr = p[0], pc = p[1], i = idx(pr, pc);
            if (open[i] || flag[i] || mine[i]) continue;
            open[i] = true;
            if (adjCount(pr, pc) === 0) {
                neighbors(pr, pc).forEach(function (ni) {
                    if (!open[ni] && !flag[ni]) stack.push([Math.floor(ni / N), ni % N]);
                });
            }
        }
    }

    function openedCount() {
        var n = 0;
        for (var i = 0; i < N * N; i++) if (open[i]) n++;
        return n;
    }

    /* ---------------- 输入 ---------------- */
    function onTap(x, y, button) {
        if (dead || won) return;

        var c = Math.floor(x / CELL), r = Math.floor(y / CELL);
        if (r < 0 || r >= N || c < 0 || c >= N) return;

        if (!planted) { placeMines(r, c); planted = true; startClock(); }

        var i = idx(r, c);

        if (button === 'right') {                 // 插旗 / 取消
            if (!open[i]) flag[i] = !flag[i];
            return;
        }
        if (open[i] || flag[i]) return;

        if (mine[i]) {                            // 踩雷
            dead = true;
            for (var k = 0; k < N * N; k++) if (mine[k]) open[k] = true;
            shell.gameOver('踩雷了，用时 ' + elapsed + ' 秒');
            return;
        }

        revealFrom(r, c);

        if (openedCount() === N * N - MINES) {    // 全开 → 通关
            won = true;
            stopClock();
            elapsed = Math.max(1, secs());        // 1 秒内通关也记为 1 秒
            shell.setScore(elapsed);              // 这里才写入"最快"
            shell.win('用时 ' + elapsed + ' 秒');
        }
    }

    /* ---------------- 计时 ----------------
       自带一个 1 秒时钟，而不是复用外壳的定帧循环：
       外壳的循环在 start() 时就启动，而 t0 在点击时才赋值，
       相位差会让 floor(…) 永远少算 1 秒。这里先记 t0 再建定时器，首秒就不会丢。 */
    var clockId = null;

    function secs() {
        return t0 ? Math.floor((Date.now() - t0) / 1000) : 0;
    }

    function stopClock() {
        if (clockId) { clearInterval(clockId); clockId = null; }
    }

    function startClock() {
        stopClock();
        t0 = Date.now();
        clockId = setInterval(function () {
            if (shell.state !== 'running') return;      // 暂停 / 结束时冻结显示
            elapsed = secs();
            shell.setScore(elapsed, false);             // 只刷新显示，不记入最快
            shell.render();
        }, 1000);
    }

    /* ---------------- 绘制 ---------------- */
    function rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
        ctx.rect(x, y, w, h);
    }

    function drawFlag(ctx, x, y) {
        // 旗杆
        ctx.strokeStyle = '#f2f5fb';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + 15, y + 9);
        ctx.lineTo(x + 15, y + 30);
        ctx.stroke();
        // 底座
        ctx.strokeStyle = '#8899aa';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + 31);
        ctx.lineTo(x + 21, y + 31);
        ctx.stroke();
        // 旗面
        ctx.fillStyle = '#ff4d6a';
        ctx.beginPath();
        ctx.moveTo(x + 16, y + 9);
        ctx.lineTo(x + 30, y + 14.5);
        ctx.lineTo(x + 16, y + 20);
        ctx.closePath();
        ctx.fill();
        // 旗面描边，深色底上更立得住
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    function drawMine(ctx, x, y) {
        var cx = x + CELL / 2, cy = y + CELL / 2, r = 8;
        ctx.strokeStyle = COL.bg;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        for (var a = 0; a < 4; a++) {
            var ang = a * Math.PI / 4 + Math.PI / 8;
            ctx.beginPath();
            ctx.moveTo(cx - Math.cos(ang) * (r + 5), cy - Math.sin(ang) * (r + 5));
            ctx.lineTo(cx + Math.cos(ang) * (r + 5), cy + Math.sin(ang) * (r + 5));
            ctx.stroke();
        }
        ctx.fillStyle = COL.bg;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // 高光点
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.arc(cx - 2.5, cy - 3, 2, 0, Math.PI * 2);
        ctx.fill();
    }

    function onDraw(ctx) {
        // 先铺一层不透明底色：以前靠半透明白叠 CSS 背景，翻开格只有 +7% 白，
        // 和未开格几乎同色（实测 rgb(38,49,76) vs rgb(36,48,80)），肉眼分不出。
        ctx.fillStyle = COL.bg;
        ctx.fillRect(0, 0, W, H);

        for (var r = 0; r < N; r++) {
            for (var c = 0; c < N; c++) {
                var i = idx(r, c), x = c * CELL, y = r * CELL;

                if (open[i]) {
                    // ---- 已翻开：下沉的深色面 ----
                    if (mine[i]) {
                        ctx.fillStyle = COL.boom;
                        ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
                        drawMine(ctx, x, y);
                        continue;
                    }

                    ctx.fillStyle = COL.openFace;
                    ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
                    // 上/左一条暗边，强化"挖下去"的凹陷感
                    ctx.strokeStyle = COL.openEdge;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x + 2.5, y + 2.5);
                    ctx.lineTo(x + 2.5, y + CELL - 2.5);
                    ctx.moveTo(x + 2.5, y + 2.5);
                    ctx.lineTo(x + CELL - 2.5, y + 2.5);
                    ctx.stroke();

                    var n = adjCount(r, c);
                    if (n) {
                        ctx.fillStyle = NUM_COLORS[n] || '#e8ecf5';
                        ctx.font = 'bold 20px "Courier New", monospace';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(String(n), x + CELL / 2, y + CELL / 2 + 1);
                    }
                } else {
                    // ---- 未翻开：亮面凸起（上亮下暗 + 高光边） ----
                    var g = ctx.createLinearGradient(0, y + 2, 0, y + CELL - 2);
                    g.addColorStop(0, COL.closedTop);
                    g.addColorStop(1, COL.closedBot);
                    ctx.fillStyle = g;
                    rrect(ctx, x + 2, y + 2, CELL - 4, CELL - 4, 4);
                    ctx.fill();

                    ctx.strokeStyle = COL.closedLine;
                    ctx.lineWidth = 1;
                    ctx.stroke();

                    // 顶部高光，做出浮雕手感
                    ctx.strokeStyle = COL.closedHi;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x + 5, y + 3.5);
                    ctx.lineTo(x + CELL - 5, y + 3.5);
                    ctx.stroke();

                    if (flag[i]) drawFlag(ctx, x, y);
                }
            }
        }
    }

    /* ---------------- 启动 ---------------- */
    shell = new GameShell({
        mount: '#game-shell',
        gameKey: 'minesweeper',
        width: W,
        height: H,
        tickMs: 0,                    // 回合制：计时时钟由游戏自带（见 startClock）
        autostart: true,              // 进来直接能玩
        startButton: false,           // 玩家驱动，不放「开始游戏」
        scoreLabel: '⏱ 用时',
        bestLabel: '🏆 最快',
        unit: '秒',
        lowerIsBetter: true,
        dpad: false,                  // 扫雷不用方向输入，别在手机上摆一副没用的十字键
        tip: '左键点开　·　右键 / 长按插旗（再右键取消）',
        onReset: reset,
        onDraw: onDraw,
        onTap: onTap
    });
})();
