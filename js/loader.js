/**
 * 芯宇识字 —— 入口加载器（bootstrap）
 * ---------------------------------------------------------------------------
 * index.html 只留一个空壳 #app 和一个 loader.js，
 * 页面的一切（结构、逻辑、样式、字库）都由下面清单里的文件动态加载，
 * 全部从远端服务器取 —— 页面本身不带任何本地副本，也不做「悄悄退回旧文件」
 * 那种兜底：远端拿不到就把原因摆到页面上，别让人对着白屏猜。
 *
 *     远端  https://decadeguo.github.io/out_link/js/after.js
 *
 * 所以以后改远端文件就等于改页面，不用重新打包。
 *
 * 远端目录结构（以 out_link 仓库为例）：
 *     out_link/js/render_html.js
 *     out_link/js/words-loader.js
 *     out_link/js/after.js
 *     out_link/css/index.css
 *
 * 几个必须知道的取舍（都是踩过的坑）：
 *   1. 只能用 <script src> / <link href> 加载，不能用 fetch：
 *      远端页面 fetch 会被跨域拦掉。
 *   2. 远端 URL 一律拼 ?_t=时间戳：那台静态服务器只回 Last-Modified，
 *      没有 Cache-Control / ETag，浏览器会一直复用旧脚本，改了远端也不生效。
 *   3. 远端地址按顺序试，第一个成功的就**锁定**，后面的文件都从它取。
 *      不锁定的话可能出现「结构来自 A 站、逻辑来自 B 站的旧版本」这种错位页面。
 *      锁定的地址挂了也不换站，直接报错把整页停下，绝不拼一个半新半旧的页面。
 *   4. 熔断：某个脚本所有远端地址都试完还是不通，本次加载剩下的资源直接失败收场，
 *      否则 4 个资源 × 2 个地址 × 超时 = 白屏等到天荒地老。
 *      样式是唯一的例外（见 6），它失败既不致命也不熔断。
 *   5. 模块不做热替换：after.js 重复执行会重复绑定键盘/点击事件，
 *      表现为「按一下跳两格」。远端更新在下次加载（刷新 / 重开应用）时生效。
 *      字库是纯数据，可以安全热更新，见 words-loader.js。
 *   6. 样式是唯一的例外：index.css 挂了不当致命错误，脚本照常往下加载，
 *      页面丑但能用；脚本挂了才是真没救，直接进 fatal。
 *   7. index.html 里 loader.js 的地址是写死的远端地址，
 *      换服务器 / 加备用站要同时改这里和 index.html。
 * ---------------------------------------------------------------------------
 */
(function (global) {
    "use strict";

    /* ========================= 改这里 ========================= */
    var CONFIG = {
        // 远端根目录，**按顺序**试，第一个通的锁定使用。
        // 换服务器 / 加备用站改这里（index.html 里的 loader.js 地址是另一处）
        remoteBases: [
            "https://decadeguo.github.io/out_link/",
            "https://cdn.jsdelivr.net/gh/decadeGuo/out_link@main/"
        ],
        // 单个资源超时（毫秒）
        timeout: 4000,
        // 样式表
        css: ["css/index.css"],
        // 脚本，**按顺序执行**，有依赖关系不要调换：
        //   render_html.js  先把页面结构写进 #app
        //   words-loader.js 再拉字库
        //   after.js        最后绑事件、渲染
        js: ["js/render_html.js", "js/words-loader.js", "js/after.js"]
    };
    /* ========================================================== */

    var state = {
        activeBase: null,  // 锁定使用的远端根目录，null = 还没锁定
        remoteDead: false, // 远端确认不通了，剩下的资源不用再各等一遍超时
        sources: {},       // path -> 命中它的远端地址，排查电视上到底用的哪台
        errors: [],        // 失败原因，最后要摆到页面上
        done: false
    };

    /* ------------------------------ 工具 ------------------------------ */

    function reason(e) {
        return e && e.message ? e.message : String(e);
    }

    // 绕开 HTTP 缓存（远端服务器没有 Cache-Control / ETag）
    function bust(url) {
        return url + (url.indexOf("?") < 0 ? "?" : "&") + "_t=" + Date.now();
    }

    // 加载一个远端资源，超时也算失败：远端卡住时不能让页面白屏干等。
    // kind = "js" → <script src>；"css" → <link href>
    function request(kind, url) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement(kind === "css" ? "link" : "script");
            var timer = null;
            var settled = false;

            function finish(err) {
                if (settled) return;
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (err) {
                    el.onload = null;
                    el.onerror = null;
                    if (el.parentNode) el.parentNode.removeChild(el);
                    reject(err);
                } else {
                    resolve();
                }
            }

            if (kind === "css") {
                el.rel = "stylesheet";
                el.href = url;
            } else {
                el.src = url;
                el.async = false; // 动态脚本默认 async，这里保证按顺序执行
            }
            el.onload = function () { finish(null); };
            el.onerror = function () { finish(new Error("加载失败: " + url)); };

            timer = setTimeout(function () {
                finish(new Error("加载超时(" + CONFIG.timeout + "ms): " + url));
            }, CONFIG.timeout);

            document.head.appendChild(el);
        });
    }

    /* ---------------------------- 远端加载 ---------------------------- */

    // 依次试远端地址。用 then 的第二个参数接失败，不要用 catch：
    // 否则后面 return 的 rejection 会被同一个 catch 再兜一次，白跑一轮
    function tryBases(bases, i, path, kind, errors) {
        if (i >= bases.length) {
            return Promise.reject(new Error(errors.join(" | ")));
        }

        var base = bases[i];
        return request(kind, bust(base + path)).then(function () {
            if (!state.activeBase) state.activeBase = base; // 锁定第一个能用的
            state.sources[path] = base;
        }, function (e) {
            errors.push(base + " → " + reason(e));
            return tryBases(bases, i + 1, path, kind, errors);
        });
    }

    function loadOne(path, kind) {
        // 远端已经确认不通：本次加载不再让剩下的资源各等一遍超时
        if (state.remoteDead) {
            return Promise.reject(new Error("远端已熔断，跳过 " + path));
        }

        // 已经锁定过能用的地址就只用它：它缺文件也不换站，
        // 免得页面结构来自 A 站、逻辑来自 B 站的旧版本
        var bases = state.activeBase ? [state.activeBase] : CONFIG.remoteBases;

        return tryBases(bases, 0, path, kind, []).catch(function (e) {
            var why = path + " 加载失败（" + reason(e) + "）";
            state.errors.push(why);
            // 样式挂了不当致命错误：页面丑但能用，脚本继续往下加载。
            // 也不熔断，免得一个 404 的样式表把整页拖下水
            if (kind === "css") return;
            state.remoteDead = true;
            throw new Error(why);
        });
    }

    /* ------------------------------ 启动 ------------------------------ */

    function fatal(msg) {
        var app = document.getElementById("app");
        if (!app) return;
        app.innerHTML = "";

        var box = document.createElement("div");
        box.setAttribute("style",
            "position:fixed;left:0;top:0;right:0;bottom:0;" +
            "display:flex;align-items:center;justify-content:center;" +
            "padding:6vh;text-align:center;font-size:3vh;color:#8a7b63;" +
            "background:#fdf6e3;font-family:sans-serif;" +
            "white-space:pre-line;word-break:break-all;");
        box.textContent = msg;
        app.appendChild(box);
        document.title = "加载失败";
    }

    function boot() {
        var app = document.getElementById("app");

        // 先给个不依赖 css 的加载提示，远端超时时也不会白屏
        if (app && !app.firstChild) {
            app.innerHTML = '<div id="loading" style="position:fixed;left:0;top:0;' +
                'right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
                'background:#fdf6e3;color:#8a7b63;font-size:4vh;font-family:sans-serif;">' +
                '正在加载…</div>';
        }

        var chain = Promise.resolve();

        CONFIG.css.forEach(function (path) {
            chain = chain.then(function () { return loadOne(path, "css"); });
        });
        CONFIG.js.forEach(function (path) {
            chain = chain.then(function () { return loadOne(path, "js"); });
        });

        return chain.then(function () {
            state.done = true;
            return state;
        }).catch(function (e) {
            // 远端一份都没拿到，页面就是空的：把失败原因直接摆出来。
            // 只说「加载失败」在电视上没法查，一定要带上是谁、卡在哪一台服务器
            fatal("页面资源加载失败\n\n" + (state.errors.length
                ? state.errors.join("\n")
                : reason(e)));
            throw e;
        });
    }

    var api = {
        config: CONFIG,
        state: state,
        ready: null, // Promise<state>
        boot: boot,
        reload: function () { global.location.reload(); }
    };

    global.XinyuLoader = api;
    function start() {
        api.ready = boot();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})(window);
