/* ============================================================
   tetris.js — 俄罗斯方块（逻辑层）
   定帧循环 + 动态调速：每消 10 行升一级，下落间隔变短
   画布 400x600：左侧 300 为 10x20 棋盘，右侧 100 为预览栏
   ============================================================ */
(function () {
    'use strict';

    var COLS = 10, ROWS = 20, CELL = 30;
    var FIELD_W = COLS * CELL;          // 300
    var W = FIELD_W + 100;              // 400
    var H = ROWS * CELL;                // 600

    var SHAPES = {
        I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
        J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
        L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
        O: [[1, 1], [1, 1]],
        S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
        T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
        Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
    };
    var TYPES = Object.keys(SHAPES);
    var COLORS = {
        I: '#00d4ff', J: '#4a6cf7', L: '#f4a259', O: '#ffd700',
        S: '#00d47a', T: '#c77dff', Z: '#e94560'
    };
    var BASE_SPEED = 600;

    var board = [];        // ROWS x COLS，存方块类型字母，空为 0
    var cur = null;        // { type, m, x, y }
    var nextType = null;
    var score = 0, lines = 0, level = 1;
    var shell = null;

    /* ---------------- 工具 ---------------- */
    function rotate(m) {                       // 顺时针 90°
        var n = m.length, out = [];
        for (var y = 0; y < n; y++) {
            out.push([]);
            for (var x = 0; x < n; x++) out[y].push(m[n - 1 - x][y]);
        }
        return out;
    }

    function pickType() { return TYPES[Math.floor(Math.random() * TYPES.length)]; }

    function collide(m, px, py) {
        for (var y = 0; y < m.length; y++) {
            for (var x = 0; x < m.length; x++) {
                if (!m[y][x]) continue;
                var bx = px + x, by = py + y;
                if (bx < 0 || bx >= COLS || by >= ROWS) return true;
                if (by >= 0 && board[by][bx]) return true;
            }
        }
        return false;
    }

    function reset() {
        board = [];
        for (var y = 0; y < ROWS; y++) {
            board.push([]);
            for (var x = 0; x < COLS; x++) board[y].push(0);
        }
        score = 0; lines = 0; level = 1;
        nextType = pickType();
        spawn();
        if (shell) shell.setSpeed(BASE_SPEED);      // 重开时复位速度
    }

    function spawn() {
        var type = nextType || pickType();
        nextType = pickType();
        var m = SHAPES[type];
        cur = { type: type, m: m, x: Math.floor((COLS - m.length) / 2), y: 0 };
        return !collide(cur.m, cur.x, cur.y);       // false = 出生即堵死 → 结束
    }

    /* ---------------- 落定 / 消行 ---------------- */
    function lock() {
        for (var y = 0; y < cur.m.length; y++) {
            for (var x = 0; x < cur.m.length; x++) {
                if (!cur.m[y][x]) continue;
                var by = cur.y + y, bx = cur.x + x;
                if (by >= 0) board[by][bx] = cur.type;
            }
        }

        // 消行
        var cleared = 0;
        for (var r = ROWS - 1; r >= 0; r--) {
            var full = board[r].every(function (v) { return v !== 0; });
            if (full) {
                board.splice(r, 1);
                var emptyRow = [];
                for (var c = 0; c < COLS; c++) emptyRow.push(0);
                board.unshift(emptyRow);
                cleared++;
                r++;                                // 同一位置再查一次
            }
        }

        if (cleared) {
            score += [0, 40, 100, 300, 1200][cleared];
            lines += cleared;
            shell.setScore(score);
            var lv = 1 + Math.floor(lines / 10);
            if (lv !== level) {
                level = lv;
                shell.setSpeed(Math.max(120, BASE_SPEED - (level - 1) * 60));
            }
        }

        return spawn() ? null : 'over';
    }

    /* ---------------- 每帧（重力） ---------------- */
    function onTick() {
        if (!collide(cur.m, cur.x, cur.y + 1)) {
            cur.y++;
            return null;
        }
        return lock();
    }

    /* ---------------- 输入 ---------------- */
    function onDirection(dx, dy) {
        if (dx === -1) {
            if (!collide(cur.m, cur.x - 1, cur.y)) cur.x--;
        } else if (dx === 1) {
            if (!collide(cur.m, cur.x + 1, cur.y)) cur.x++;
        } else if (dy === -1) {                     // 上 = 旋转
            var r = rotate(cur.m);
            if (!collide(r, cur.x, cur.y)) cur.m = r;
        } else if (dy === 1) {                      // 下 = 加速下落
            if (!collide(cur.m, cur.x, cur.y + 1)) {
                cur.y++;
            } else if (lock() === 'over') {
                shell.gameOver('得分 ' + score);
            }
        }
        shell.render();                             // 立刻反馈，不等下一帧
    }

    /* ---------------- 绘制 ---------------- */
    function drawBlock(ctx, px, py, size, color, pad) {
        pad = pad || 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px + pad, py + pad, size - pad * 2, size - pad * 2, 4);
        else ctx.rect(px + pad, py + pad, size - pad * 2, size - pad * 2);
        ctx.fill();
    }

    function onDraw(ctx) {
        ctx.clearRect(0, 0, W, H);

        // 右侧预览栏底色
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(FIELD_W, 0, 100, H);

        // 棋盘网格
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 0.5;
        for (var x = 0; x <= COLS; x++) {
            ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); ctx.stroke();
        }
        for (var y = 0; y <= ROWS; y++) {
            ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(FIELD_W, y * CELL); ctx.stroke();
        }

        // 已落定的方块
        for (var r = 0; r < ROWS; r++) {
            for (var c = 0; c < COLS; c++) {
                if (board[r][c]) drawBlock(ctx, c * CELL, r * CELL, CELL, COLORS[board[r][c]]);
            }
        }

        // 当前方块
        for (var py = 0; py < cur.m.length; py++) {
            for (var px = 0; px < cur.m.length; px++) {
                if (!cur.m[py][px]) continue;
                var by = cur.y + py;
                if (by < 0) continue;
                drawBlock(ctx, (cur.x + px) * CELL, by * CELL, CELL, COLORS[cur.type]);
            }
        }

        // 预览栏：下一个
        ctx.fillStyle = '#8899aa';
        ctx.font = '12px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEXT', FIELD_W + 50, 24);
        ctx.fillText('LV ' + level, FIELD_W + 50, 150);
        ctx.fillText('行 ' + lines, FIELD_W + 50, 172);

        var nm = SHAPES[nextType];
        var mini = 16;
        var ox = FIELD_W + 50 - (nm.length * mini) / 2;
        var oy = 56;
        for (var ny = 0; ny < nm.length; ny++) {
            for (var nx = 0; nx < nm.length; nx++) {
                if (!nm[ny][nx]) continue;
                drawBlock(ctx, ox + nx * mini, oy + ny * mini, mini, COLORS[nextType], 1);
            }
        }
    }

    /* ---------------- 启动 ---------------- */
    shell = new GameShell({
        mount: '#game-shell',
        gameKey: 'tetris',
        width: W,
        height: H,
        tickMs: BASE_SPEED,
        scoreLabel: '🧱',
        tip: '← → 移动，↑ 旋转，↓ 加速下落',
        onReset: reset,
        onTick: onTick,
        onDraw: onDraw,
        onDirection: onDirection
    });
})();
