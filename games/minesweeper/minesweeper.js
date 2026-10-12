/* ============================================================
   minesweeper.js — 扫雷（逻辑层）
   9x9 / 10 雷；左键(点按)翻开，右键(长按)插旗；首页安全
   计分用的是"用时"，所以走 lowerIsBetter + 只在通关时记录最快
   ============================================================ */
(function () {
    'use strict';

    var N = 9, MINES = 10, CELL = 40;
    var W = N * CELL, H = N * CELL;          // 360 x 360

    var NUM_COLORS = {
        1: '#00d4ff', 2: '#00d47a', 3: '#e94560', 4: '#c77dff',
        5: '#f4a259', 6: '#00b3b3', 7: '#e8ecf5', 8: '#8899aa'
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
        ctx.fillStyle = '#e94560';
        ctx.beginPath();
        ctx.moveTo(x + 14, y + 12);
        ctx.lineTo(x + 27, y + 18);
        ctx.lineTo(x + 14, y + 24);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#e8ecf5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 13, y + 11);
        ctx.lineTo(x + 13, y + 30);
        ctx.stroke();
    }

    function drawMine(ctx, x, y) {
        var cx = x + CELL / 2, cy = y + CELL / 2, r = 8;
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = 3;
        for (var a = 0; a < 4; a++) {
            var ang = a * Math.PI / 4 + Math.PI / 8;
            ctx.beginPath();
            ctx.moveTo(cx - Math.cos(ang) * (r + 5), cy - Math.sin(ang) * (r + 5));
            ctx.lineTo(cx + Math.cos(ang) * (r + 5), cy + Math.sin(ang) * (r + 5));
            ctx.stroke();
        }
    }

    function onDraw(ctx) {
        ctx.clearRect(0, 0, W, H);

        for (var r = 0; r < N; r++) {
            for (var c = 0; c < N; c++) {
                var i = idx(r, c), x = c * CELL, y = r * CELL;

                if (open[i]) {
                    if (mine[i]) {
                        ctx.fillStyle = '#e94560';
                        ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
                        drawMine(ctx, x, y);
                        continue;
                    }
                    ctx.fillStyle = 'rgba(255,255,255,0.07)';
                    ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);

                    var n = adjCount(r, c);
                    if (n) {
                        ctx.fillStyle = NUM_COLORS[n] || '#e8ecf5';
                        ctx.font = 'bold 19px "Courier New", monospace';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(String(n), x + CELL / 2, y + CELL / 2 + 1);
                    }
                } else {
                    ctx.fillStyle = '#243050';
                    rrect(ctx, x + 1, y + 1, CELL - 2, CELL - 2, 5);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                    ctx.lineWidth = 1;
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
        scoreLabel: '⏱ 用时',
        bestLabel: '🏆 最快',
        unit: '秒',
        lowerIsBetter: true,
        tip: '左键 / 轻点翻开，右键 / 长按插旗',
        onReset: reset,
        onDraw: onDraw,
        onTap: onTap
    });
})();
