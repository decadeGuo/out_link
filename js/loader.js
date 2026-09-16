/**
 * 芯宇识字 —— 入口加载器（bootstrap）
 * ---------------------------------------------------------------------------
 * index.html 只留一个空壳 #app 和一个本地 loader.js，
 * 页面的一切（结构、逻辑、样式、字库）都由下面清单里的文件动态加载，
 * 每个文件都是「远端优先，本地兜底」：
 *
 *     远端  https://decadeguo.github.io/out_link/js/after.js
 *     本地  statics/js/after.js        ← 没网 / 远端挂了时用它
 *
 * 所以以后改远端文件就等于改页面，不用重新打包 APK。
 *
 * 远端目录结构（以 out_link 仓库为例，和本地的 statics/ 保持一致最省心）：
 *     out_link/js/render_html.js
 *     out_link/js/words-loader.js
 *     out_link/js/after.js
 *     out_link/css/index.css
 *
 * 几个必须知道的取舍（都是踩过的坑）：
 *   1. 只能用 <script src> / <link href> 加载，不能用 fetch：
 *      file:// 页面 fetch 本地文件会被跨域拦掉，而且远端可能不同源。
 *   2. 远端 URL 一律拼 ?_t=时间戳：那台静态服务器只回 Last-Modified，
 *      没有 Cache-Control / ETag，浏览器会一直复用旧脚本，改了远端也不生效。
 *   3. 远端地址按顺序试，第一个成功的就**锁定**，后面的文件都从它取。
 *      不锁定的话可能出现「结构来自 A 站、逻辑来自 B 站的旧版本」这种错位页面。
 *      锁定的地址挂了也不换站，直接退回本地，宁可整页用包里那份。
 *   4. 熔断：所有远端地址都试完还是不通，本次加载后面直接用本地，
 *      否则 4 个资源 × 3 个地址 × 超时 = 白屏等到天荒地老。
 *   5. 模块不做热替换：after.js 重复执行会重复绑定键盘/点击事件，
 *      表现为「按一下跳两格」。远端更新在下次加载（刷新 / 重开应用）时生效。
 *      字库是纯数据，可以安全热更新，见 words-loader.js。
 * ---------------------------------------------------------------------------
 */
(function (global) {
    "use strict";

    /* ========================= 改这里 ========================= */
    var CONFIG = {
        // 远端根目录，**按顺序**试，第一个通的锁定使用
        remoteBases: [
            "https://decadeguo.github.io/out_link/",
            "https://cdn.jsdelivr.net/gh/decadeGuo/out_link@main/",
            "http://192.168.5.15:9876/" // 局域网调试用（本地起静态服务时）
        ],
        // 本地兜底目录：打进 APK 的那份
        localBase: "statics/",
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
        remoteDead: false, // 远端确认不通了，后面直接用本地
        sources: {},       // path -> "remote" | "local"，排查电视上到底用的哪份
        errors: [],
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

    function localUrl(path) { return CONFIG.localBase + path; }

    // 加载并执行一个 js，timeout = 0 表示不限时（本地文件不会卡）
    function loadScript(url, timeout) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement("script");
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

            el.src = url;
            el.async = false; // 动态脚本默认 async，这里保证按顺序执行
            el.onload = function () { finish(null); };
            el.onerror = function () { finish(new Error("加载失败: " + url)); };

            if (timeout > 0) {
                timer = setTimeout(function () {
                    finish(new Error("加载超时(" + timeout + "ms): " + url));
                }, timeout);
            }

            document.head.appendChild(el);
        });
    }

    // 加载一个 css。样式挂了不影响功能，所以失败也只标记来源，不往外抛
    function loadCss(url, timeout) {
        return new Promise(function (resolve, reject) {
            var link = document.createElement("link");
            var timer = null;
            var settled = false;

            function finish(err) {
                if (settled) return;
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (err) reject(err);
                else resolve();
            }

            link.rel = "stylesheet";
            link.href = url;
            link.onload = function () { finish(null); };
            link.onerror = function () { finish(new Error("加载失败: " + url)); };

            if (timeout > 0) {
                timer = setTimeout(function () {
                    finish(new Error("加载超时(" + timeout + "ms): " + url));
                }, timeout);
            }

            document.head.appendChild(link);
        });
    }

    /* ---------------------------- 远端优先 ---------------------------- */

    // 依次试远端地址。用 then 的第二个参数接失败，不要用 catch：
    // 否则后面 return 的 rejection 会被同一个 catch 再兜一次，白跑一轮
    function tryBases(bases, i, path, load, errors) {
        if (i >= bases.length) {
            return Promise.reject(new Error(errors.join(" | ")));
        }

        var base = bases[i];
        return load(bust(base + path), CONFIG.timeout).then(function () {
            if (!state.activeBase) state.activeBase = base; // 锁定第一个能用的
            state.sources[path] = "remote";
            state.sources[path + "#base"] = base;
        }, function (e) {
            errors.push(base + " → " + reason(e));
            return tryBases(bases, i + 1, path, load, errors);
        });
    }

    function loadOne(path, kind) {
        var load = kind === "css" ? loadCss : loadScript;

        function useLocal(why) {
            state.errors.push(path + " 用本地兜底（" + why + "）");
            return load(localUrl(path), kind === "css" ? 3000 : 0).then(function () {
                state.sources[path] = "local";
            });
        }

        // 远端已经确认不通：本次加载不再让每个文件各等一遍超时
        if (state.remoteDead) {
            return useLocal("远端不通，已熔断");
        }

        // 已经锁定过能用的地址就只用它：它缺文件也不换站，
        // 免得页面结构来自 A 站、逻辑来自 B 站的旧版本
        var bases = state.activeBase ? [state.activeBase] : CONFIG.remoteBases;

        return tryBases(bases, 0, path, load, []).catch(function (e) {
            state.remoteDead = true;
            return useLocal(reason(e));
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
            "padding:6vh;text-align:center;font-size:4vh;color:#8a7b63;" +
            "background:#fdf6e3;font-family:sans-serif;");
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
            // 连打包进来的本地文件都没有，只能把错误摆出来
            fatal("页面资源加载失败：" + reason(e));
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
