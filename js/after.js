(function () {
    "use strict";

    // 字库列表：key 对应 words.js 里 window.words_xxx
    var BOOKS = [
        { key: "youeryuan", name: "幼儿园学的字" },
        { key: "common",    name: "常见字" }
    ];

    var PREF_KEY = "xinyu_word_pref";

    var state = {
        book: 0,          // 当前字库
        random: false,    // false = 顺序模式，true = 随机模式
        showTip: false,    // 是否显示图形
        order: [],        // 当前播放顺序（随机模式下是打乱的索引）
        pos: 0,           // 在 order 里的位置
        menuIndex: -1     // -1 = 焦点在内容区，>=0 = 焦点在菜单第几项
    };

    function $(id) { return document.getElementById(id); }
    var elProgress = $("progress"),
        elTip = $("tip"), elWord = $("word"), elPinyin = $("pinyin"),
        elStatus = $("status"), elLoading = $("loading"),
        elMenubar = $("menubar"),
        elWaring = $("waring");
    var btnBook = $("btnBook"), btnMode = $("btnMode"), btnTip = $("btnTip");
    var MENU = [btnBook, btnMode, btnTip];

    /* ---------------- 数据 ---------------- */

    function list() {
        return BOOKS[state.book].list || [];
    }

    // 当前显示的字，在原始数组里的下标
    function realIndex() {
        var o = state.order;
        if (!o.length) return 0;
        var p = Math.max(0, Math.min(state.pos, o.length - 1));
        return o[p];
    }

    // 生成播放顺序。keep = true 时尽量停回当前这个字
    function buildOrder(keep) {
        var cur = keep ? realIndex() : 0;
        var o = [];
        for (var i = 0; i < list().length; i++) o.push(i);

        if (state.random) {
            // Fisher-Yates 洗牌
            for (var j = o.length - 1; j > 0; j--) {
                var k = Math.floor(Math.random() * (j + 1));
                var t = o[j]; o[j] = o[k]; o[k] = t;
            }
        }

        state.order = o;
        var p = o.indexOf(cur);
        state.pos = p < 0 ? 0 : p;
    }

    /* ---------------- 渲染 ---------------- */

    function renderMenu() {
        btnBook.textContent = "字库：" + BOOKS[state.book].name;
        btnMode.textContent = "模式：" + (state.random ? "随机" : "顺序");
        btnTip.textContent  = "图形：" + (state.showTip ? "显示" : "隐藏");

        for (var i = 0; i < MENU.length; i++) {
            if (i === state.menuIndex) MENU[i].classList.add("focused");
            else MENU[i].classList.remove("focused");
        }
    }

    function render() {
        var arr = list();
        renderMenu();

        if (!arr.length) {
            elTip.textContent = "";
            elWord.textContent = "空";
            elPinyin.textContent = "";
            elProgress.textContent = "0 / 0";
            return;
        }

        var item = arr[realIndex()] || {};
        elTip.textContent = item.tip || "";
        elTip.style.display = state.showTip ? "" : "none";
        elWord.textContent = item.word || "";
        elPinyin.textContent = item.pinyin || "";
        elProgress.textContent = (state.pos + 1) + " / " + arr.length;
    }

    /* ---------------- 操作 ---------------- */

    // 左右换字（首尾循环）
    function move(delta) {
        var n = list().length;
        if (!n) return;
        state.pos = (state.pos + delta + n) % n;
        render();
    }

    // 换字库
    function switchBook(delta) {
        state.book = (state.book + delta + BOOKS.length) % BOOKS.length;
        buildOrder(false);
        render();
        savePref();
    }

    // 顺序 / 随机
    function toggleMode() {
        state.random = !state.random;
        buildOrder(true);
        render();
        savePref();
    }

    // 图形 显示 / 隐藏
    function toggleTip() {
        state.showTip = !state.showTip;
        render();
        savePref();
    }

    /* ---------------- 菜单焦点（遥控器） ---------------- */

    function enterMenu() {
        state.menuIndex = 0;
        renderMenu();
    }

    function exitMenu() {
        state.menuIndex = -1;
        renderMenu();
    }

    function moveFocus(delta) {
        var n = MENU.length;
        state.menuIndex = (state.menuIndex + delta + n) % n;
        renderMenu();
    }

    function activate() {
        if (state.menuIndex === 0) switchBook(1);
        else if (state.menuIndex === 1) toggleMode();
        else if (state.menuIndex === 2) toggleTip();
    }

    /* ---------------- 偏好保存 ---------------- */

    function loadPref() {
        try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; }
        catch (e) { return {}; }
    }

    function savePref() {
        try {
            localStorage.setItem(PREF_KEY, JSON.stringify({
                book: state.book,
                random: state.random,
                showTip: state.showTip
            }));
        } catch (e) { /* localStorage 不可用就跳过 */ }
    }

    /* ---------------- 遥控器按键 ---------------- */
    function keyOf(e) {
        var k = e.key, c = e.keyCode;
        if (k === "ArrowLeft"  || k === "Left"   || c === 37) return "left";
        if (k === "ArrowRight" || k === "Right"  || c === 39) return "right";
        if (k === "ArrowUp"    || k === "Up"     || c === 38) return "up";
        if (k === "ArrowDown"  || k === "Down"   || c === 40) return "down";
        if (k === "Enter"      || k === "Select" || c === 13) return "ok";
        return null;
    }

    document.addEventListener("keydown", function (e) {
        var key = keyOf(e);
        if (!key) return;
        e.preventDefault();

        // 焦点在菜单上：上下选、确定切换、左右退回内容区
        if (state.menuIndex >= 0) {
            if (key === "up")         moveFocus(-1);
            else if (key === "down")  moveFocus(1);
            else if (key === "ok")    activate();
            else                      exitMenu();
            return;
        }

        // 焦点在内容区
        if (key === "left")       move(-1);
        else if (key === "right") move(1);
        else if (key === "ok")    move(1);
        else if (key === "up")    enterMenu();     // 上：进菜单
        else if (key === "down")  switchBook(1);   // 下：快速换字库
    });

    // 菜单按钮：鼠标 / 触摸点击
    btnBook.addEventListener("click", function () { switchBook(1); });
    btnMode.addEventListener("click", function () { toggleMode(); });
    btnTip.addEventListener("click",  function () { toggleTip(); });

    // 内容区：点左半边 / 右半边 → 上一个字 / 下一个字
    document.addEventListener("click", function (e) {
        if (elMenubar.contains(e.target)) return;   // 菜单栏自己处理
        move(e.clientX < window.innerWidth / 2 ? -1 : 1);
    });

    /* ---------------- 启动 ---------------- */
    function sourceName(s) {
        return { remote: "远端", local: "内置" }[s] || s;
    }

    // 远端失败的原因必须显示出来。不然只看到「内置」两个字，
    // 会以为程序放着远端不用，其实只是远端那次没拉上
    function shortReason(msg) {
        if (!msg) return "未知原因";
        if (msg.indexOf("超时") >= 0) return "连接超时";
        if (msg.indexOf("加载失败") >= 0) return "连不上";
        if (msg.indexOf("没拿到字库数据") >= 0) return "文件内容异常";
        return String(msg).slice(0, 12);
    }

    function statusText(snap) {
        if (!snap.errors || !snap.errors.length) {
            return sourceName(snap.source) + " · " + snap.version;
        }
        return sourceName(snap.source) + " · " + snap.version +
               "（远端" + shortReason(snap.errors[0]) + "，后台重试中）";
    }

    // keepPos = true：热更新时尽量停回当前这个字，别把用户正在看的位置跳走
    function applySnapshot(snap, keepPos) {
        BOOKS[0].list = snap.youeryuan || [];
        BOOKS[1].list = snap.common || [];
        if (state.book < 0 || state.book >= BOOKS.length) state.book = 0;

        buildOrder(keepPos);
        elStatus.textContent = statusText(snap);
        elWaring.textContent = snap.waring || "版权所有";
        render();
    }

    // 让 WebView 把按键事件交给页面
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();

    // 后台重试成功后热更新：不用重启应用就能看到新字库
    XinyuWords.onUpdate = function (snap) {
        applySnapshot(snap, true);
    };

    XinyuWords.ready.then(function (snap) {
        // 恢复上次的设置
        var pref = loadPref();
        if (typeof pref.book === "number" && pref.book >= 0 && pref.book < BOOKS.length) {
            state.book = pref.book;
        }
        if (typeof pref.random === "boolean") state.random = pref.random;
        if (typeof pref.showTip === "boolean") state.showTip = pref.showTip;

        elLoading.style.display = "none";
        applySnapshot(snap, false);
    }).catch(function (err) {
        elLoading.textContent = "字库加载失败：" + (err && err.message ? err.message : err);
    });
})();