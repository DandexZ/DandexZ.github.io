/* ============================================================
   physics.js — 纯圆形刚体物理（位置约束法 / PBD）
   ------------------------------------------------------------
   只做圆：重力、圆-圆碰撞、边界反弹、库仑摩擦、静止收敛、碰撞上报。
   不含 DOM / 渲染 / 游戏规则，因此可以在 node 里直接跑数值断言。
   UMD：浏览器挂 window.CirclePhysics，node 走 module.exports。

   为什么用位置约束而不是纯冲量积分：
   圆堆叠时冲量法容易互相穿透、抖动、甚至"炸开"；PBD 先做位置修正
   （各让一半，留 slop 容忍微小穿透），再顺带修正法向/切向速度，
   少量迭代就能得到稳定的堆叠。

   两个"手感"上的关键设计（都是踩过坑才定下来的）：
   · **摩擦用库仑模型**（切向冲量上限 μ·法向冲量），不用"速度阈值"判静/动。
     速度阈值做法会让重力每步注入的那点切向速度（~g·h）永远低于阈值 →
     摩擦每次都按"静摩擦"把切向速度整个抹掉 → 水果一碰就锁死、滑不下去，
     看起来像"粘住"（用户原话：落到已有物体上会粘连，不符合现实）。
     库仑模型下缓坡（tanθ<μ）能堆住、陡坡自然滑落，才是对的。
   · **睡眠延迟**（sleep timer）：被支撑且低速要持续 sleepDelay 秒才真正睡稳。
     当帧清零会让水果一触地就变成贴图；真实碰撞用 _disturbed 唤醒整堆。
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();            // node
    } else {
        root.CirclePhysics = factory();        // 浏览器
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* 把标量截断到 [-m, m]（库仑摩擦冲量上限） */
    function clampAbs(v, m) {
        return v > m ? m : (v < -m ? -m : v);
    }

    function World(opts) {
        opts = opts || {};
        this.width  = opts.width  || 400;
        this.height = opts.height || 560;

        this.gravity     = opts.gravity == null ? 1600 : opts.gravity;      // px/s²
        this.restitution = opts.restitution == null ? 0.2 : opts.restitution;      // 水果间弹性
        this.wallRestitution = opts.wallRestitution == null ? 0.24 : opts.wallRestitution; // 墙体弹性
        // 摩擦系数 μ（静=动）。tanθ > μ 的斜面才会滑，所以 μ 决定"能堆多陡"。
        // 0.3 ≈ 16.7°：正上方能架住，偏心（架在别的球侧面上）会自然滑落，不"粘住"。
        this.friction    = opts.friction == null ? 0.3 : opts.friction;
        // 圆形滚动：真实的圆球有转动自由度，落在有坡度的地方会"滚"下去。
        // 滚动没有角度阈值（纯滑动要 tanθ > μ 才动），所以没有它，水果会叠成竖直柱子、
        // 或卡在堆顶下不来 —— 用户原话："水果落在顶上很难往下落，不符合物理"。
        this.rolling     = opts.rolling !== false;
        this.angularDamping = opts.angularDamping == null ? 0.995 : opts.angularDamping;
        this.iterations  = opts.iterations || 8;      // 每子步的约束迭代次数
        this.substeps    = opts.substeps || 2;
        this.slop        = opts.slop == null ? 0.5 : opts.slop;   // 允许的微小穿透（抗抖动）
        this.linearDamping = opts.linearDamping == null ? 0.999 : opts.linearDamping;
        this.sleepSpeed  = opts.sleepSpeed == null ? 14 : opts.sleepSpeed;  // 低于此速度才可能入睡
        // 睡眠延迟（秒）：被支撑 + 低速 要"持续"这么久才真正睡稳。
        // 太短 → 一触地就冻住（很假）；太长 → 堆积一直微动。
        this.sleepDelay  = opts.sleepDelay == null ? 0.4 : opts.sleepDelay;
        // 唤醒速度：被砸中后速度超过它 → 立即重新参与完整模拟。
        this.wakeSpeed   = opts.wakeSpeed == null ? 60 : opts.wakeSpeed;
        // 恢复系数阈值：接近速度低于它时按"完全非弹性"处理（e=0）。
        // 不加这个，重力每步注入的 ~g·h 速度会让静止的堆积永远微抖。
        this.restThreshold = opts.restThreshold == null ? 40 : opts.restThreshold;
        this.maxVel      = opts.maxVel || 2600;       // 限速，避免极端穿透
        // 单次位置修正上限：深重叠时若一次弹开太多，物体会被"瞬移"出去（甚至飞出盒子）。
        this.maxCorrection = opts.maxCorrection == null ? 4 : opts.maxCorrection;
        // 睡眠窗口内的速度衰减（每步），让落地是"落定"而不是"啪一下冻住"
        this.settleDamping = opts.settleDamping == null ? 0.9 : opts.settleDamping;
        // 注：数值属性叫 maxVel，别叫 maxSpeed —— 后者是本类的方法名，
        // 实例属性会遮蔽原型方法（真踩过：this.maxSpeed() is not a function）

        this.bodies = [];
        this.contacts = [];      // 本步发生接触的 [a, b] 对（合并逻辑的数据来源）
        this._nextId = 1;
        this._contactKeys = null;
        this.steps = 0;
    }

    /* ---------------- 增删 ---------------- */
    World.prototype.add = function (b) {
        var body = {
            id: this._nextId++,
            x: b.x,
            y: b.y,
            vx: b.vx || 0,
            vy: b.vy || 0,
            omega: b.omega || 0,          // 角速度（滚动）
            r: b.r,
            mass: b.mass || (b.r * b.r),  // 质量 ∝ 面积：大水果更"重"，不能被小水果撞飞
            tier: b.tier == null ? 0 : b.tier,
            data: b.data
        };
        this.bodies.push(body);
        return body;
    };

    World.prototype.remove = function (body) {
        var i = this.bodies.indexOf(body);
        if (i >= 0) this.bodies.splice(i, 1);
    };

    World.prototype.clear = function () {
        this.bodies.length = 0;
        this.contacts.length = 0;
        this.steps = 0;
    };

    /* ---------------- 推进 ---------------- */
    World.prototype.step = function (dt) {
        if (!(dt > 0)) return;
        var h = dt / this.substeps;
        var n = this.bodies.length;

        this.contacts.length = 0;
        this._contactKeys = {};
        for (var z = 0; z < n; z++) {
            this.bodies[z]._supported = false;
            this.bodies[z]._disturbed = false;   // 本步是否被"真实碰撞"砸到
        }

        for (var k = 0; k < this.substeps; k++) {
            // 1) 积分（重力 + 阻尼 + 限速 + 位移）
            //    resting（已睡稳）的物体本步不加重力：否则它每步被推下去一点点，
            //    位置修正又会沿斜向法线把它横向弹开，堆积就会慢慢"摊开"。
            var damp = Math.pow(this.linearDamping, h * 60);
            for (var i = 0; i < n; i++) {
                var b = this.bodies[i];
                if (b.resting) continue;

                b.vy += this.gravity * h;
                b.vx *= damp;
                b.vy *= damp;
                if (this.rolling) b.omega *= Math.pow(this.angularDamping, h * 60);

                var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
                if (sp > this.maxVel) {
                    var s = this.maxVel / sp;
                    b.vx *= s;
                    b.vy *= s;
                }
                b.x += b.vx * h;
                b.y += b.vy * h;
            }

            // 2) 约束迭代（位置修正 + 法向/切向速度修正）
            for (var it = 0; it < this.iterations; it++) {
                for (var a = 0; a < n; a++) {
                    for (var c = a + 1; c < n; c++) {
                        this._solvePair(this.bodies[a], this.bodies[c], it === 0 && k === 0);
                    }
                }
                for (var w = 0; w < n; w++) this._solveWalls(this.bodies[w]);
            }

            // 3) 墙面/地面切向摩擦：每子步只做一次（放在迭代外，避免重复叠加）
            for (var wf = 0; wf < n; wf++) this._wallFriction(this.bodies[wf], h);
        }

        this._settle(dt);
        this.steps++;
    };

    World.prototype._record = function (a, b) {
        var key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
        if (this._contactKeys[key]) return;
        this._contactKeys[key] = true;
        this.contacts.push([a, b]);
    };

    /* 圆-圆：位置修正（各让一半）+ 法向冲量（含恢复系数）+ 库仑摩擦 */
    World.prototype._solvePair = function (a, b, record) {
        var dx = b.x - a.x, dy = b.y - a.y;
        var rsum = a.r + b.r;
        var d2 = dx * dx + dy * dy;
        if (d2 > rsum * rsum) return;

        var d = Math.sqrt(d2);
        var nx, ny;
        if (d < 1e-6) {                     // 完全重合：给个确定性的分离方向
            nx = 1; ny = 0; d = 0;
        } else {
            nx = dx / d; ny = dy / d;
        }

        if (record) this._record(a, b);

        // 支撑判定：只有"竖向"接触才算被托住。
        // 若只要求"有接触"，一起下落的水平接触群体会被整体冻在空中。
        if (ny > 0.2) a._supported = true;          // b 在 a 下方 → a 被 b 托住
        else if (ny < -0.2) b._supported = true;    // a 在 b 下方 → b 被 a 托住

        // 逆质量：位置修正与冲量都按它分配 —— 重的动得少
        var ia = 1 / a.mass, ib = 1 / b.mass, isum = ia + ib;

        var pen = rsum - d;
        if (pen > this.slop) {
            var total = Math.min(pen - this.slop, this.maxCorrection * 2);
            a.x -= nx * total * (ia / isum); a.y -= ny * total * (ia / isum);
            b.x += nx * total * (ib / isum); b.y += ny * total * (ib / isum);
        }

        // 法向相对速度：< 0 表示正在靠近
        var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
            // 真碰撞（不是静止接触的微小挤压）→ 把整堆"惊醒"，避免被砸中也不动
            if (-vn > this.restThreshold) { a._disturbed = true; b._disturbed = true; }

            // 慢速接触视为完全非弹性，否则堆积区会被重力一点点"喂"成永动机
            var e = (-vn < this.restThreshold) ? 0 : this.restitution;
            var jn = -(1 + e) * vn / isum;                    // 法向冲量
            a.vx -= nx * jn * ia; a.vy -= ny * jn * ia;
            b.vx += nx * jn * ib; b.vy += ny * jn * ib;

            // 库仑摩擦：切向冲量上限 μ·jn。
            // 需要的冲量小于上限 → 静摩擦（不滑）；否则按上限滑动。
            // 注意别用"速度阈值"判静/动：重力每步注入的切向速度（~g·h）总是很小，
            // 那种写法会永远走"静摩擦"分支把切向速度整个抹掉 → 水果一碰就粘住滑不下去。
            var tx = -ny, ty = nx;
            // 接触点的切向相对速度 = 圆心相对速度 + 两球转动带来的表面速度(ω·r)
            var spin = this.rolling ? (b.omega * b.r + a.omega * a.r) : 0;
            var vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty - spin;
            // 切向有效质量：无转动 1/isum；圆盘 I=½mr²（含转动耦合）降到 1/(3·isum)
            var jtStop = -vt / (this.rolling ? 3 * isum : isum);
            var jtMax = this.friction * jn;
            var jt = jtStop > jtMax ? jtMax : (jtStop < -jtMax ? -jtMax : jtStop);
            a.vx -= tx * jt * ia; a.vy -= ty * jt * ia;
            b.vx += tx * jt * ib; b.vy += ty * jt * ib;
            if (this.rolling) {                               // 摩擦冲量同时改变转动
                a.omega -= 2 * jt * ia / a.r;
                b.omega -= 2 * jt * ib / b.r;
            }
        }
    };

    /* 墙体：左右下三面有界，顶部开放（水果从上方落）。
       同样使用恢复系数阈值：贴着墙/地静止时把法向速度清零，而不是留弹性一直弹。 */
    World.prototype._solveWalls = function (b) {
        var e = this.wallRestitution;
        var th = this.restThreshold;
        if (b.x - b.r < 0) {
            b.x = b.r;
            if (b.vx < 0) b.vx = (Math.abs(b.vx) < th) ? 0 : -b.vx * e;
        } else if (b.x + b.r > this.width) {
            b.x = this.width - b.r;
            if (b.vx > 0) b.vx = (Math.abs(b.vx) < th) ? 0 : -b.vx * e;
        }
        if (b.y + b.r > this.height) {
            b.y = this.height - b.r;
            if (b.vy > 0) b.vy = (Math.abs(b.vy) < th) ? 0 : -b.vy * e;
        }
        // 地面是硬支撑；左右墙不算"托住"（贴墙但悬空的东西应该继续往下滑）
        if (b.y + b.r > this.height - 0.0001) b._supported = true;
    };

    /* 墙面/地面的切向摩擦（库仑，Δv_t ≤ μ·g·h）。
       没有它，被撞到的水果会沿着地面几乎无摩擦地滑出去很远。 */
    World.prototype._wallFriction = function (b, h) {
        var jtMax = this.friction * this.gravity * h;      // ≈ μ ×（法向冲量）
        var denom = this.rolling ? 3 : 1;                  // 圆盘滚动时切向有效质量 m/3
        var jt;
        if (b.y + b.r > this.height - 0.0001) {            // 地面：切向是 x
            jt = clampAbs((b.vx - (this.rolling ? b.omega * b.r : 0)) / denom, jtMax);
            b.vx -= jt;
            if (this.rolling) b.omega += 2 * jt / b.r;
        }
        if (b.x - b.r < 0.0001 || b.x + b.r > this.width - 0.0001) {   // 侧墙：切向是 y
            jt = clampAbs((b.vy - (this.rolling ? b.omega * b.r : 0)) / denom, jtMax);
            b.vy -= jt;
            if (this.rolling) b.omega += 2 * jt / b.r;
        }
    };

    /* 静止收敛（sleep timer）：
       1) 被"真实碰撞"砸中（_disturbed）或失去支撑 → 清零计时并唤醒。
          —— 下方水果被合并掉时，上面的不会悬空冻住；
          —— 新水果砸进堆里时，整堆会重新落定，而不是像贴图一样钉住。
       2) 被支撑 + 低速：累计安静时间；达到 sleepDelay 才真正睡稳（速度清零、跳过重力）。
          未睡稳前做温和衰减 → 落地是"落定"过程，有惯性感。
       3) 其余（速度偏高，比如正在沿斜面滑动）→ 清零计时，保持模拟。
       注：这张计时器是关键——"当帧清零"的版本水果一触地就完全不动，很假。 */
    World.prototype._settle = function (dt) {
        var s = this.sleepSpeed;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);

            if (b._disturbed || !b._supported) {
                b._restTime = 0;
                b.resting = false;
                continue;
            }

            if (sp < s) {
                b._restTime = (b._restTime || 0) + dt;
                if (b._restTime >= this.sleepDelay) {
                    b.vx = 0;
                    b.vy = 0;
                    b.omega = 0;
                    b.resting = true;                 // 睡稳：线速度/角速度归零、跳过重力
                } else {
                    b.resting = false;
                    b.vx *= this.settleDamping;       // 落定缓冲（非瞬间冻住）
                    b.vy *= this.settleDamping;
                    b.omega *= this.settleDamping;
                }
            } else {
                b._restTime = 0;
                b.resting = false;
            }
        }
    };

    /* ---------------- 诊断（供测试 / 调试用） ---------------- */
    World.prototype.maxOverlap = function () {
        var worst = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            for (var j = i + 1; j < this.bodies.length; j++) {
                var a = this.bodies[i], b = this.bodies[j];
                var d = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
                var ov = (a.r + b.r) - d;
                if (ov > worst) worst = ov;
            }
        }
        return worst;
    };

    World.prototype.maxSpeed = function () {
        var worst = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            var s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (s > worst) worst = s;
        }
        return worst;
    };

    /** 总机械能（动能 + 重力势能），用于验证"能量在衰减而不是被注入" */
    World.prototype.energy = function () {
        var e = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            var I = 0.5 * b.mass * b.r * b.r;
            e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy) + 0.5 * I * b.omega * b.omega
               + b.mass * this.gravity * (this.height - b.y);
        }
        return e;
    };

    /** 越界检测：返回越界体的数量（忽略 slop） */
    World.prototype.outOfBounds = function (tol) {
        tol = tol == null ? 1 : tol;
        var bad = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            if (b.x < b.r - tol || b.x > this.width - b.r + tol ||
                b.y > this.height - b.r + tol ||
                b.x !== b.x || b.y !== b.y) {          // NaN 也算越界
                bad++;
            }
        }
        return bad;
    };

    /** 是否全部静止（速度上限低于阈值） */
    World.prototype.isSettled = function (tol) {
        tol = tol == null ? 2 : tol;
        return this.maxSpeed() < tol;
    };

    /** 已睡稳（resting）的物体数量 —— 用于验证"最终真的停下来" */
    World.prototype.sleepingCount = function () {
        var c = 0;
        for (var i = 0; i < this.bodies.length; i++) if (this.bodies[i].resting) c++;
        return c;
    };

    return { World: World };
});
