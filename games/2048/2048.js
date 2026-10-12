/* ============================================================
   2048.js — 2048（逻辑层）
   回合制游戏：tickMs = 0，不跑定时器，每次方向输入后重绘
   ============================================================ */
(function () {
    'use strict';

    var SIZE = 4;
    var W = 400, H = 400;
    var PAD = 17, GAP = 10;
    var CELL = (W - PAD * 2 - GAP * (SIZE - 1)) / SIZE;   // 84

    var COLORS = {
        2: '#2f3d5e', 4: '#35507f', 8: '#1f7a8c', 16: '#2a9d8f',
        32: '#3fb27f', 64: '#8cc63f', 128: '#f2c14e', 256: '#f4a259',
        512: '#e76f51', 1024: '#e94560', 2048: '#ff2e63'
    };

    var board = [];          // 长度 16 的一维数组，行优先
    var score = 0;
    var dead = false, won = false;
    var shell = null;

    /* ---------------- 工具 ---------------- */
    function rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function addRandomTile() {
        var free = [];
        for (var i = 0; i < SIZE * SIZE; i++) if (!board[i]) free.push(i);
        if (!free.length) return;
        var idx = free[Math.floor(Math.random() * free.length)];
        board[idx] = Math.random() < 0.9 ? 2 : 4;     // 90% 出 2
    }

    function reset() {
        board = [];
        for (var i = 0; i < SIZE * SIZE; i++) board.push(0);
        score = 0;
        dead = false;
        won = false;
        addRandomTile();
        addRandomTile();
    }

    /* ---------------- 移动逻辑 ---------------- */
    // 取第 i 条线，顺序按"靠墙的一侧在前"，这样统一按向左压缩处理
    function getLine(i, dx, dy) {
        var out = [];
        for (var k = 0; k < SIZE; k++) {
            var x, y;
            if (dx === 1)       { x = SIZE - 1 - k; y = i; }
            else if (dx === -1) { x = k;            y = i; }
            else if (dy === 1)  { x = i; y = SIZE - 1 - k; }
            else                { x = i; y = k; }
            out.push(board[y * SIZE + x]);
        }
        return out;
    }

    function setLine(i, dx, dy, vals) {
        for (var k = 0; k < SIZE; k++) {
            var x, y;
            if (dx === 1)       { x = SIZE - 1 - k; y = i; }
            else if (dx === -1) { x = k;            y = i; }
            else if (dy === 1)  { x = i; y = SIZE - 1 - k; }
            else                { x = i; y = k; }
            board[y * SIZE + x] = vals[k];
        }
    }

    // 压缩 + 合并（每个格子一帧只合并一次）
    function slide(vals) {
        var compact = vals.filter(function (v) { return v > 0; });
        var out = [], gained = 0;
        for (var i = 0; i < compact.length; i++) {
            if (i + 1 < compact.length && compact[i] === compact[i + 1]) {
                var merged = compact[i] * 2;
                out.push(merged);
                gained += merged;
                i++;                                   // 跳过被吃掉的同伴
            } else {
                out.push(compact[i]);
            }
        }
        while (out.length < SIZE) out.push(0);
        return { arr: out, gained: gained };
    }

    function move(dx, dy) {
        var before = board.slice();
        var gained = 0;
        for (var i = 0; i < SIZE; i++) {
            var r = slide(getLine(i, dx, dy));
            gained += r.gained;
            setLine(i, dx, dy, r.arr);
        }
        var changed = board.some(function (v, k) { return v !== before[k]; });
        return { changed: changed, gained: gained };
    }

    function canMove() {
        for (var i = 0; i < SIZE * SIZE; i++) if (!board[i]) return true;
        for (var y = 0; y < SIZE; y++) {
            for (var x = 0; x < SIZE; x++) {
                var v = board[y * SIZE + x];
                if (x + 1 < SIZE && board[y * SIZE + x + 1] === v) return true;
                if (y + 1 < SIZE && board[(y + 1) * SIZE + x] === v) return true;
            }
        }
        return false;
    }

    /* ---------------- 输入 ---------------- */
    function onDirection(dx, dy) {
        if (dead || won) return;

        var r = move(dx, dy);
        if (!r.changed) return;              // 该方向无效，不生成新块

        if (r.gained > 0) {
            score += r.gained;
            shell.setScore(score);
        }
        addRandomTile();

        for (var i = 0; i < SIZE * SIZE; i++) {
            if (board[i] >= 2048) {
                won = true;
                shell.win('达成 2048！得分 ' + score);
                return;
            }
        }
        if (!canMove()) {
            dead = true;
            shell.gameOver('无路可走，得分 ' + score);
        }
    }

    /* ---------------- 绘制 ---------------- */
    function onDraw(ctx) {
        ctx.clearRect(0, 0, W, H);

        // 底板
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        rrect(ctx, PAD - 6, PAD - 6, W - (PAD - 6) * 2, H - (PAD - 6) * 2, 14);
        ctx.fill();

        for (var y = 0; y < SIZE; y++) {
            for (var x = 0; x < SIZE; x++) {
                var v = board[y * SIZE + x];
                var px = PAD + x * (CELL + GAP);
                var py = PAD + y * (CELL + GAP);

                ctx.fillStyle = v ? (COLORS[v] || '#ff2e63') : 'rgba(255,255,255,0.06)';
                rrect(ctx, px, py, CELL, CELL, 10);
                ctx.fill();

                if (v) {
                    ctx.fillStyle = v >= 128 ? '#1a1a2e' : '#e8ecf5';
                    var size = v >= 1024 ? 28 : (v >= 128 ? 32 : 38);
                    ctx.font = 'bold ' + size + 'px "Courier New", monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(v), px + CELL / 2, py + CELL / 2 + 1);
                }
            }
        }
    }

    /* ---------------- 启动 ---------------- */
    shell = new GameShell({
        mount: '#game-shell',
        gameKey: '2048',
        width: W,
        height: H,
        tickMs: 0,                                   // 回合制
        autostart: true,                             // 进来直接能玩
        startButton: false,                          // 玩家驱动，不放「开始游戏」
        scoreLabel: '🔢',
        tip: '← ↑ → ↓ / WASD 移动，相同数字合并',
        onReset: reset,
        onDraw: onDraw,
        onDirection: onDirection
    });
})();
