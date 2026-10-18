package website.baka.game

import android.os.Bundle
import android.view.WindowManager
import com.getcapacitor.BridgeActivity
import website.baka.game.channel.BakaChannelPlugin

/**
 * Capacitor 壳主 Activity。只做三件事：装载内嵌前端、注册通道插件、窗口级防录屏。
 * 不含任何业务 UI（UI 全部来自内嵌的 Client 构建产物）。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // FLAG_SECURE：系统层阻断截屏/录屏/MediaProjection 对本窗口的采集（计划 P3.3）
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
    }

    override fun init() {
        super.init()
        // 本地插件直接注册，替代独立 @capacitor 插件包（保持前端只有一处桥接）
        bridge?.registerPlugin(BakaChannelPlugin())
    }
}
