package website.baka.game.channel

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorManager
import android.os.Build
import java.io.File

/**
 * 运行时检测（计划 P3.3）。只产出事实码列表，判定在服务端；
 * 客户端的 hard/soft 划分与桌面端 P2.3 口径一致：
 *   hardFail 任一命中 → 拒进 BakaAntiCheat 房；softFail ≥2 → 拒。
 *
 * 误伤优先降级：拿不准的一律进 softFail，并把服务标识原样带上，
 * 便于服务端按「已核实的好服务」加白与人工复核。
 */
object SelfCheck {

    data class Report(val hardFail: List<String>, val softFail: List<String>, val attestationLevel: String)

    // ---- 无障碍白名单：常见输入法与读屏软件（读屏类命中直接放行，不打扰无障碍用户）----
    // 清单维护规则：只收「人工核实过用途」的包名前缀，不收猜出来的占位条目——
    // 占位匹配不到任何服务是死配置，万一恰好匹配上一个不相干的包就成了放行通道。
    // 没进名单的服务走 accessibility_unknown（软失败），一条照样放行，只是标记可疑。
    private val ACCESSIBILITY_WHITELIST = setOf(
        "com.google.android.marvin.talkback",           // TalkBack 读屏
        "com.google.android.accessibility.selecttospeak", // 选定朗读
        "com.google.android.accessibility.switchaccess",  // 开关控制
        "com.samsung.android.accessibility.talkback",   // 三星读屏
        "com.samsung.android.app.aireader",             // 三星 Screen Reader
        "com.huawei.android.accessibility.hmt",         // 华为读屏
        "com.miui.accessibility",                       // 小米无障碍套件
        "com.baidu.input",                              // 百度输入法（注册辅助服务）
        "com.sohu.inputmethod.sogou",                   // 搜狗输入法
        "com.iflytek.inputmethod"                       // 讯飞输入法
    )

    // ---- 已知自动化外挂特征（命中即 hardFail）----
    private val AUTOMATION_BLACKLIST = setOf(
        "org.autojs.autojs",         // Auto.js
        "org.autojs.autojspro",      // Auto.js Pro
        "org.autojs.autoxjs",        // AutoX
        "com.cyjh.mobileanjian",     // 按键精灵
        "com.touchsprite.android",   // 触动精灵
        "com.autotap",               // 通用点击器前缀占位
    )

    fun check(context: Context): Report {
        val hard = mutableListOf<String>()
        val soft = mutableListOf<String>()

        checkAccessibility(context, hard, soft)
        checkRoot(hard)
        checkEmulator(context, hard, soft)
        checkMediaProjection(context, soft)
        checkClone(context, hard, soft)
        checkKeystore(hard)

        return Report(hard, soft, attestationLevel(context))
    }

    // ---- 无障碍服务：白名单放行 / 黑名单硬拒 / 未知软拒 ----
    private fun checkAccessibility(context: Context, hard: MutableList<String>, soft: MutableList<String>) {
        try {
            val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE)
                as? android.view.accessibility.AccessibilityManager ?: return
            // AccessibilityServiceInfo 在 android.accessibilityservice 包下，
            // 不是 android.view.accessibility（后者只有 AccessibilityManager 与事件类）。
            for (info in manager.getEnabledAccessibilityServiceList(
                android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK
            )) {
                val id = info.resolveInfo.serviceInfo.packageName + "/" + info.resolveInfo.serviceInfo.name
                if (AUTOMATION_BLACKLIST.any { id.contains(it, ignoreCase = true) }) {
                    hard.add("accessibility_automation:$id")
                } else if (!ACCESSIBILITY_WHITELIST.any { id.startsWith(it, ignoreCase = true) }) {
                    // 未知服务不硬拒：误伤无障碍用户的代价高于漏放一个工具
                    soft.add("accessibility_unknown:$id")
                }
            }
        } catch (e: Exception) {
            soft.add("accessibility_check_failed")
        }
    }

    // ---- Root / Magisk ----
    private fun checkRoot(hard: MutableList<String>) {
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su", "/vendor/bin/su",
            "/system/app/Superuser.apk", "/system/su", "/su/bin/su",
        )
        for (p in suPaths) {
            if (File(p).canExecute() || File(p).exists()) hard.add("root_su:$p")
        }
        if (Build.TAGS != null && Build.TAGS.contains("test-keys")) hard.add("root_test_keys")
        if (readProp("ro.debuggable") == "1") hard.add("root_debuggable")
        val magiskPaths = listOf("/sbin/.magisk", "/data/adb/magisk", "/data/adb/modules", "/debug_ramdisk/.magisk")
        for (p in magiskPaths) {
            if (File(p).exists()) hard.add("root_magisk:$p")
        }
        try {
            val mounts = File("/proc/mounts").readText()
            if (mounts.contains("magisk")) hard.add("root_magisk_mount")
        } catch (e: Exception) { /* /proc 被 SELinux 挡住时静默跳过，不作为证据 */ }
    }

    // ---- 模拟器 ----
    private fun checkEmulator(context: Context, hard: MutableList<String>, soft: MutableList<String>) {
        val fingerprint = Build.FINGERPRINT.orEmpty().lowercase()
        val hardware = Build.HARDWARE.orEmpty().lowercase()
        val product = Build.PRODUCT.orEmpty().lowercase()
        val manufacturer = Build.MANUFACTURER.orEmpty().lowercase()
        val markers = listOf("generic", "emulator", "vbox", "goldfish", "ranchu", "sdk_gphone", "ttvm", "cancro", "droid4x", "nox", "memu", "bluestacks", "mumu", "vmos", "vphone")
        if ((fingerprint + hardware + product + manufacturer).let { all -> markers.any { all.contains(it) } }) {
            hard.add("emulator_build")
        }
        if (readProp("ro.kernel.qemu") == "1") hard.add("emulator_qemu")
        // 传感器缺失（真机必有加速度计）；陀螺仪缺失的低端真机存在 → 只算软
        try {
            val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            if (sensors?.getSensorList(Sensor.TYPE_ACCELEROMETER)?.isEmpty() == true) hard.add("emulator_no_accelerometer")
            else if (sensors?.getSensorList(Sensor.TYPE_GYROSCOPE)?.isEmpty() == true) soft.add("emulator_no_gyroscope")
        } catch (e: Exception) { /* 无传感器服务时不加分 */ }
        val abi = Build.SUPPORTED_ABIS.firstOrNull()?.lowercase().orEmpty()
        if (abi.contains("x86")) soft.add("abi_x86") // 极少数真 x86 手机，故不硬拒
    }

    // ---- 录屏 / MediaProjection ----
    // Android 8+ 无法枚举其它应用的 MediaProjection 服务；窗口级防线由 MainActivity 的
    // FLAG_SECURE 承担（系统直接黑屏采集）。这里只做 best-effort 进程侧探测。
    private fun checkMediaProjection(context: Context, soft: MutableList<String>) {
        if (Build.VERSION.SDK_INT < 26) {
            try {
                @Suppress("DEPRECATION")
                val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
                val running = am?.getRunningServices(200).orEmpty()
                if (running.any { it.service.className.contains("MediaProjection", ignoreCase = true) }) {
                    soft.add("media_projection_active")
                }
            } catch (e: Exception) { /* best-effort */ }
        }
        // unsafeCheckOpNoThrow 自 API 29 起才有；更老的系统上调用会抛 NoSuchMethodError（Error，
        // 下面的 catch 接不住），只能跳过这一项 best-effort 探测。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        try {
            val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? android.app.AppOpsManager
            val mode = appOps?.unsafeCheckOpNoThrow(
                "android:project_media",
                android.os.Process.myUid(),
                context.packageName,
            )
            // unsafeCheckOpNoThrow 返回 Int（AppOpsManager 的模式常量），不是枚举，没有 ordinal。
            if (mode == android.app.AppOpsManager.MODE_ALLOWED) soft.add("media_projection_allowed") // 异常态（本 app 从不申请投影）
        } catch (e: Exception) { /* API 差异，忽略 */ }
    }

    // ---- 多开 / 分身 ----
    private fun checkClone(context: Context, hard: MutableList<String>, soft: MutableList<String>) {
        val appInfo = context.applicationInfo
        val source = appInfo.sourceDir.orEmpty()
        // 正常安装路径应含自身包名；分身框架下路径指向宿主包（如 /data/user/0/<host>/...）
        if (source.isNotEmpty() && !source.contains(context.packageName)) hard.add("clone_source_path")
        if (source.startsWith("/data/user/") && !source.startsWith("/data/user/0/")) hard.add("clone_user_data")
        val userId = android.os.Process.myUid() / 100000
        if (userId != 0) soft.add("clone_user_id") // 工作资料用户会命中，属可解释的软信号
        // Context.getDataDir() 返回 File（API 24+），要拿路径得用 absolutePath。
        val data = context.dataDir.absolutePath
        if (data.isNotEmpty() && !data.contains(context.packageName)) soft.add("clone_data_dir")
    }

    // ---- Keystore 可用性（sign 的前置）----
    private fun checkKeystore(hard: MutableList<String>) {
        try {
            java.security.KeyStore.getInstance("AndroidKeyStore").load(null)
        } catch (e: Exception) {
            hard.add("keystore_unavailable")
        }
    }

    private fun attestationLevel(context: Context): String {
        return try {
            val chain = KeystoreChannel.ensureCertificateChain(context)
            AttestationLocal.read(chain.firstOrNull()).attestationLevel()
        } catch (e: Exception) {
            "degraded" // 读不到扩展 ≠ 设备被破坏：交给服务端按失败态分档处置
        }
    }

    /** android.os.SystemProperties 属半公开 API，反射失败按 null 处理 */
    private fun readProp(key: String): String? = try {
        val clazz = Class.forName("android.os.SystemProperties")
        clazz.getMethod("get", String::class.java).invoke(null, key) as? String
    } catch (e: Exception) {
        null
    }
}
