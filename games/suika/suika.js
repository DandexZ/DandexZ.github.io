/* ============================================================
   suika.js — 合成大西瓜（游戏逻辑 + 渲染）
   物理交给 physics.js（纯圆 PBD），页面外壳交给 game-shell.js。
   本文件只负责：水果链、投放、合并升级、计分、警戒线、绘制。
   ============================================================ */
(function () {
    'use strict';

    var W = 400, H = 560;

    // 水果链：樱桃 → 葡萄 → 橘子 → 柠檬 → 猕猴桃 → 番茄 → 桃子 → 菠萝 → 椰子 → 西瓜
    var TIERS = [
        { name: '樱桃',   r: 16, color: '#c62828' },
        { name: '葡萄',   r: 21, color: '#8e44ad' },
        { name: '橘子',   r: 27, color: '#f39c12' },
        { name: '柠檬',   r: 34, color: '#e8c547' },
        { name: '猕猴桃', r: 41, color: '#7cb342' },
        { name: '番茄',   r: 49, color: '#e74c3c' },
        { name: '桃子',   r: 58, color: '#ff8a80' },
        { name: '菠萝',   r: 67, color: '#d4a017' },
        { name: '椰子',   r: 76, color: '#8d6e63' },
        { name: '西瓜',   r: 88, color: '#2e7d32' }
    ];
    // 合成出第 t 级的分数（第 0 级是投放物，不计分）
    var SCORE = [0, 2, 4, 8, 16, 32, 64, 128, 256, 512];
    var MAX_TIER = TIERS.length - 1;
    var WATERMELON_BONUS = 1000;      // 两个西瓜相撞：双双消失 + 大额奖励

    var DROPPABLE = 5;                // 只有最小的 5 种会被投放
    var SPAWN_Y = 46;                 // 出生高度（在警戒线上方）
    var LINE_Y = 96;                  // 警戒线
    var DANGER_LIMIT = 1.2;           // 有水果"停在"线上方超过这么久 → 结束
    var DROP_COOLDOWN = 0.35;         // 两次投放的最小间隔（秒）
    var FIXED = 1 / 120;              // 物理固定步长

    var world = new CirclePhysics.World({ width: W, height: H });

    var score = 0;
    var curTier = 0;
    var aimX = W / 2;
    var cooldown = 0, danger = 0, over = false;
    var floats = [];                  // 合并时上浮的 "+N"
    var shell = null;

    var clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
    function rndTier() { return Math.floor(Math.random() * DROPPABLE); }

    /* ---------------- 重置 ---------------- */
    function reset() {
        world.clear();
        score = 0;
        over = false;
        danger = 0;
        cooldown = 0;
        aimX = W / 2;
        floats.length = 0;
        curTier = rndTier();
    }

    /* ---------------- 投放 ----------------
       落点加一点微抖动（±1px，占画布 0.25%，肉眼不可见）：
       数学上"完全对心"的上下堆叠是亚稳态 —— 法线完全竖直、没有切向力，圆既不滑也不滚，
       于是同一点连投会叠成竖直柱子（实测堆高 446px）。现实里没有完美对心，
       给一点抖动，水果就会自然滚开摊平（实测堆高 95px）。 */
    var SPAWN_JITTER = 1;

    function dropAt(x) {
        if (over || cooldown > 0) return null;
        var r = TIERS[curTier].r;
        var jit = (Math.random() * 2 - 1) * SPAWN_JITTER;
        var cx = clamp(x + jit, r + 2, W - r - 2);
        var body = world.add({ x: cx, y: SPAWN_Y, r: r, tier: curTier });
        cooldown = DROP_COOLDOWN;
        curTier = rndTier();
        return body;
    }

    /* ---------------- 合并 ---------------- */
    function addScore(n) {
        score += n;
        shell.setScore(score);
    }

    function addFloat(x, y, text) {
        floats.push({ x: x, y: y, text: text, life: 1 });
    }

    function mergePair(a, b) {
        var tier = a.tier;
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        var vx = (a.vx + b.vx) * 0.25, vy = (a.vy + b.vy) * 0.25;   // 合并后动能大幅衰减

        world.remove(a);
        world.remove(b);

        if (tier >= MAX_TIER) {                    // 两个西瓜 → 双双消失
            addScore(WATERMELON_BONUS);
            addFloat(mx, my, '+' + WATERMELON_BONUS);
            return;
        }

        var nt = tier + 1;
        world.add({ x: mx, y: my, r: TIERS[nt].r, tier: nt, vx: vx, vy: vy });
        addScore(SCORE[nt]);
        addFloat(mx, my, '+' + SCORE[nt]);
    }

    function resolveMerges() {
        var pairs = world.contacts;
        if (!pairs.length) return;
        var used = {};
        for (var i = 0; i < pairs.length; i++) {
            var a = pairs[i][0], b = pairs[i][1];
            if (used[a.id] || used[b.id]) continue;
            if (a.tier !== b.tier) continue;
            used[a.id] = true;
            used[b.id] = true;
            mergePair(a, b);
        }
    }

    /* ---------------- 视觉状态（只剩合并飘字） ---------------- */
    function decayVisuals(dt) {
        var i;
        for (i = floats.length - 1; i >= 0; i--) {
            floats[i].life -= dt * 1.4;
            floats[i].y -= dt * 26;
            if (floats[i].life <= 0) floats.splice(i, 1);
        }
    }

    /* ---------------- 结束判定 ----------------
       只有"已经停稳"（被支撑住）且顶部越过警戒线才算违规。
       否则刚投下的水果穿过警戒线时会误触发（上一版就是这么错的）。 */
    function checkDanger(dt) {
        var bad = false;
        for (var i = 0; i < world.bodies.length; i++) {
            var b = world.bodies[i];
            if (b.resting && b.y - b.r < LINE_Y) { bad = true; break; }
        }
        if (bad) {
            danger += dt;
            if (danger >= DANGER_LIMIT) {
                over = true;
                shell.gameOver('得分 ' + score);
            }
        } else {
            danger = 0;
        }
    }

    /* ---------------- 唯一的物理推进入口 ----------------
       帧循环与测试都走这里：advance(dt) 一定推进 dt 秒（内部按块算，
       单块不超过 12 步，避免一次补太多卡住主线程）。
       注意别把"总时长"截断成"单块时长"——那样 advance(1.6) 只推进 0.1 秒，
       调用方（尤其测试）会以为时间过去了。（上一版就是这么错的，真踩过。） */
    var MAX_STEPS_PER_CHUNK = 12;

    function advance(dt) {
        if (over || !(dt > 0)) return;
        cooldown = Math.max(0, cooldown - dt);

        var remaining = dt;
        while (remaining > 0 && !over) {
            var steps = Math.min(MAX_STEPS_PER_CHUNK, Math.max(1, Math.round(remaining / FIXED)));
            for (var s = 0; s < steps; s++) {
                world.step(FIXED);
                resolveMerges();
                decayVisuals(FIXED);
                checkDanger(FIXED);
                if (over) return;
            }
            remaining -= steps * FIXED;
        }
    }

    /* ---------------- 每帧 ---------------- */
    var lastT = 0;

    function onTick() {
        var now = Date.now();
        var dt = lastT ? (now - lastT) / 1000 : FIXED;
        lastT = now;
        if (dt > 0.1) dt = 0.1;                  // 切标签页回来时不要一次性快进
        advance(dt);
        return null;
    }

    /* ---------------- 输入 ---------------- */
    function onTap(x, y, button) {
        if (button !== 'left') return;
        aimX = x;
        dropAt(x);
    }

    function onMove(x) {
        aimX = clamp(x, 0, W);
    }

    /* ---------------- 绘制 ---------------- */
    /* 刚体圆：永远是正圆、半径恒定（早先的 squash/pop 椭圆变形看着很假，已去掉） */
    function drawFruit(ctx, x, y, r, color) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 高光，纯色圆看起来更立体一点
        ctx.beginPath();
        ctx.arc(x - r * 0.30, y - r * 0.32, r * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.30)';
        ctx.fill();
    }

    function onDraw(ctx) {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, 0, W, H);

        // 警戒线：越危险越亮（会呼吸）
        var pulse = danger > 0
            ? 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(Date.now() / 110))
            : 0.35;
        if (ctx.setLineDash) ctx.setLineDash([9, 7]);
        ctx.strokeStyle = 'rgba(233,69,96,' + pulse.toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, LINE_Y);
        ctx.lineTo(W, LINE_Y);
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);

        // 瞄准线与落点预览（原色显示，方便一眼看清是哪种水果）
        if (!over) {
            var r = TIERS[curTier].r;
            if (ctx.setLineDash) ctx.setLineDash([5, 6]);
            ctx.strokeStyle = 'rgba(255,255,255,0.16)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(aimX, LINE_Y + 10);
            ctx.lineTo(aimX, H - 8);
            ctx.stroke();
            if (ctx.setLineDash) ctx.setLineDash([]);

            drawFruit(ctx, clamp(aimX, r + 2, W - r - 2), SPAWN_Y, r, TIERS[curTier].color);
        }

        // 水果（刚体圆：不做拉伸/挤压形变）
        for (var i = 0; i < world.bodies.length; i++) {
            var b = world.bodies[i];
            drawFruit(ctx, b.x, b.y, b.r, TIERS[b.tier].color);
        }

        // 合并飘字
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (var f = 0; f < floats.length; f++) {
            var fl = floats[f];
            ctx.globalAlpha = Math.max(0, Math.min(1, fl.life));
            ctx.fillStyle = '#ffd700';
            ctx.font = 'bold 17px "Courier New", monospace';
            ctx.fillText(fl.text, fl.x, fl.y);
        }
        ctx.globalAlpha = 1;
    }

    /* ---------------- 启动 ---------------- */
    shell = new GameShell({
        mount: '#game-shell',
        gameKey: 'suika',
        width: W,
        height: H,
        tickMs: 16,                      // ≈60fps
        scoreLabel: '🍉',
        tip: '点击 / 轻点落点投放水果',
        autostart: true,                 // 进来直接能玩，不需要「开始游戏」
        startButton: false,              // 不渲染「开始游戏」按钮
        longPress: false,                // 长按不当右键：按住瞄准、松手投放
        dpad: false,                     // 这个游戏不用方向键，窄屏也不显示方向键
        onReset: reset,
        onTick: onTick,
        onDraw: onDraw,
        onTap: onTap,
        onMove: onMove
    });

    // 测试/调试用的同步入口：可以跳过真实时间直接快进物理
    window.__suika = {
        world: world,
        tiers: TIERS,
        lineY: LINE_Y,
        drop: dropAt,
        advance: advance,
        state: function () {
            return {
                score: score,
                over: over,
                danger: danger,
                bodies: world.bodies.length,
                cur: curTier,
                aimX: aimX,
                maxOverlap: world.maxOverlap(),
                outOfBounds: world.outOfBounds(1)
            };
        }
    };
})();
