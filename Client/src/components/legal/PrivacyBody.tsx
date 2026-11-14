import { LegalSection } from "@/components/common/LegalSection";

/** 正文与「最后更新」日期只有一份：只在「关于项目」的隐私标签页渲染。 */
export const PRIVACY_UPDATED_AT = "2026-11-15";

/**
 * 一条信息项：来源、用途、保留（与可选的说明）固定样板，标签与样式只在这里写一份。
 * 保留是必填项：每收集一项都要说清留多久，代码里没有固定期限的就写明由谁决定。
 */
function DataItem({
  title,
  source,
  purpose,
  retention,
  note,
}: {
  title: string;
  source: string;
  purpose: string;
  retention: string;
  note?: string;
}) {
  const rows: [string, string | undefined][] = [
    ["来源", source],
    ["用途", purpose],
    ["保留", retention],
    ["说明", note],
  ];
  return (
    <div>
      <dt className="font-serif text-sm font-semibold">{title}</dt>
      <dd className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">
        {rows.map(([label, text]) =>
          text === undefined ? null : (
            <p key={label}>
              <span className="text-foreground">{label}：</span>
              {text}
            </p>
          )
        )}
      </dd>
    </div>
  );
}

export function PrivacyBody() {
  return (
    <>
      <p className="text-sm leading-6 text-muted-foreground">
        本页说明
        BakaGame（下称「本站」）会收集哪些信息、信息从哪里来、用来做什么、留多久，以及你如何联系我们处理相关信息。本站不要求注册即可游玩，游客状态下的信息收集范围更小。
      </p>

      <LegalSection title="一、我们收集的信息">
        <dl className="space-y-4">
          <DataItem
            title="账号资料：QQ 号、昵称与头像（仅在使用账号功能时）"
            source="登录时你输入的 QQ 号，账号以对应的 QQ 邮箱登录，验证码发到这个邮箱；账号昵称取自你的 QQ 昵称，由运营方自建的 QQ 昵称查询服务读取；头像经站内代理从 QQ 头像服务获取。登录时输入 QQ 号后显示的预览头像例外，由你的浏览器直接向 QQ 头像服务请求。"
            purpose="创建与识别账号、登录验证、展示昵称与头像。QQ 号默认不公开，只有你本人在资料设置中开启后，其他玩家才能通过资料卡看到。"
            retention="账号存续期间一直保留。验证码只保存摘要，过期作废；头像图片只在服务器内存里短时缓存，数据库只记录头像的摘要。"
          />

          <DataItem
            title="登录会话与通行密钥"
            source="登录成功后建立的会话记录，包含登录时浏览器的标识（User-Agent），不记录 IP 地址；你主动添加通行密钥时，保存密钥的公钥、你给它起的名字和设备类型，私钥不会离开你的设备。"
            purpose="保持登录状态、用通行密钥登录。"
            retention="会话 30 天未使用即失效，退出登录时删除本次会话；通行密钥保留到你在账号设置里删除它。"
          />

          <DataItem
            title="对局记录"
            source="你在房间内的对局过程与结算：当局昵称、得分与关键事件，包括谁是卧底的描述发言、投票与夜间行动，听歌猜歌和猜动漫角色的每次猜测。登录后游玩的，记录还关联你的账号 ID。"
            purpose="后台复盘、对局统计、反作弊与问题排查。"
            retention="长期保留。"
            note="对局记录不包含房间聊天内容。"
          />

          <DataItem
            title="排位赛记录（仅在参加 CEE 排位赛时）"
            source="排位赛需要登录并使用 BakaGame 客户端。记录每场的昵称、积分变化、客户端类型与版本、排队等待时长，以及每次猜测的角色与时刻。"
            purpose="计算排位积分、展示战绩与复核对局。"
            retention="长期保留。"
          />

          <DataItem
            title="站内反馈"
            source="你提交的类型、标题与内容，以及提交时所在的页面路径与浏览器标识（User-Agent）。游客可以匿名提交；登录后提交的反馈关联你的账号。"
            purpose="处理你反馈的问题；登录后提交的反馈可以在站内收到回复。反馈会同步到错误监控服务（Sentry），附带页面路径；登录后提交的还附带账号 ID 与昵称，便于把问题和报错对上。"
            retention="长期保留，便于跟进同类问题。"
          />

          <DataItem
            title="客户端设备登记（仅在使用 BakaGame 桌面或安卓客户端时）"
            source="客户端首次启动时随机生成的设备公钥，以及客户端类型、平台、密钥的保护方式、安卓系统出具的设备完整性证明等级、登记时间与最近使用时间。"
            purpose="识别官方客户端，供需要客户端的房间与排位赛做入场校验。设备公钥由客户端随机生成，登记记录不含你的账号与 IP 地址。"
            retention="设备 180 天未使用后删除。"
          />

          <DataItem
            title="反作弊复核记录（仅在开启 BakaAntiCheat 的房间）"
            source="触发复核的回合记录：玩家名、账号 ID（游客为空）、客户端类型，以及判定所依据的操作特征与评分，例如猜测的间隔节奏、猜测前是否检索过、第一次猜测是否命中。"
            purpose="供管理员人工复核疑似作弊；系统不会据此自动处罚。"
            retention="长期保留。"
          />

          <DataItem
            title="访问统计"
            source="浏览器里随机生成的匿名访客标识，以及你访问的板块（如首页、各游戏大厅、关于页，不含房号）。登录状态下的访问同时记录账号 ID。"
            purpose="统计访问量与各板块的热度。"
            retention="按天汇总的访客记录保留 90 天；各板块每天的浏览次数长期保留，其中不含访客与账号信息。"
            note="访客标识与当天日期一起做摘要后才写入数据库，数据库里看不出两天的访问来自同一访客；登录状态下的访问因为关联了账号 ID，可以对上。访问统计不记录 IP 地址。"
          />

          <DataItem
            title="访问日志与 IP 地址"
            source="你访问本站时产生的网络请求，包括边缘节点写入的客户端 IP 地址。"
            purpose="安全审计、访问限流、故障排查与服务稳定性维护。限流计数只存在服务器内存里。"
            retention="运行日志写在服务器本地，并发往运营方配置的日志服务，保留时长由运维按排查故障的需要决定，目前没有固定期限。"
            note="数据库里的登录会话与管理后台审计记录都不保存 IP 地址。"
          />

          <DataItem
            title="Cookie 与浏览器本地存储"
            source="你使用本站时由浏览器保存。"
            purpose="会话 Cookie 用于保持登录状态与完成通行密钥校验；本地存储用于记住昵称、房间设置、音量、主题等界面偏好与客户端更新提示，以及一个随机生成的匿名访客标识。登录并开启云同步后，部分偏好会同步到你的账号。"
            retention="本地数据由你的浏览器保存，清除浏览器数据即删除；同步到账号的偏好随账号保留。"
          />

          <DataItem
            title="错误与性能数据（Sentry）"
            source="客户端与服务端运行时自动采集。客户端数据经本站服务器转发至 Sentry，Sentry 收到的来源地址是本站服务器，不是你的 IP。"
            purpose="定位崩溃、接口异常与性能问题。数据可能包含错误堆栈、页面路径、浏览器与设备类型、客户端版本与构建版本；服务端的告警日志可能带有账号 ID。一部分会话与出错的会话会附带一段页面操作回放，回放中的文字一律遮挡，图片与媒体一律屏蔽。"
            retention="由 Sentry 按其服务的保留期限删除。"
          />

          <DataItem
            title="音乐平台账号凭据（仅在你主动配置时）"
            source="你主动填写或扫码登录产生的网易云音乐、QQ 音乐凭据。"
            purpose="以你的身份向对应平台请求歌曲信息与播放地址，并支持账号设置的云端同步。"
            retention="凭据保存在你的浏览器里：勾选保存登录状态时长期保存，否则关闭标签页即清除。登录、开启云同步并勾选保存时，服务端另存一份加密的云端副本，只有你本人能读写；在云同步开启时退出音乐平台，云端副本随之删除。"
            note="浏览器里的这份凭据没有加密，请不要在公用设备上勾选保存登录状态。"
          />

          <DataItem
            title="房间聊天消息"
            source="你在房间内发送的聊天内容。"
            purpose="实时展示给房间内玩家；服务重启时随房间状态恢复仍在进行的房间。"
            retention="房间存续期间保存在服务器内存里，房间结束后不再保留；服务重启时随房间快照暂存在服务器本地，恢复后立即删除。谁是卧底房间的聊天内容还会写入服务端运行日志，保留时长同上方的访问日志。"
            note="聊天消息不写入对局记录。"
          />
        </dl>
      </LegalSection>

      <LegalSection title="二、第三方服务">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <span className="font-semibold">腾讯 QQ：</span>
            QQ 头像由站内代理获取，登录时的预览头像由你的浏览器直接请求；QQ 昵称查询服务通过 QQ
            读取昵称，查询时会把 QQ 号发给腾讯；登录验证码经邮件服务投递到你的 QQ 邮箱。
          </li>
          <li>
            <span className="font-semibold">Bangumi：</span>
            提供番剧、角色与相关资料。请求由本站服务器发出，不带你的账号或身份信息。
          </li>
          <li>
            <span className="font-semibold">网易云音乐、QQ 音乐：</span>
            提供歌曲搜索、试听与账号相关能力。你使用对应功能时，本站服务器会带上你配置的凭据代你请求；歌曲封面由你的浏览器直接从平台加载。这些请求受对应平台隐私政策约束。
          </li>
          <li>
            <span className="font-semibold">Sentry：</span>
            接收经本站服务器转发的错误与性能数据，用于监控与故障排查。
          </li>
          <li>
            <span className="font-semibold">Better Stack：</span>
            提供外部可用性监测。其监测节点会定期访问本站公开地址；后端只读取其监测结果，不向其发送账号或对局数据。
          </li>
        </ul>
        <p>除上述服务与法律法规要求外，本站不出售、不出租、不向无关第三方提供你的个人信息。</p>
      </LegalSection>

      <LegalSection title="三、信息的存储与安全">
        <ul className="list-disc space-y-2 pl-5">
          <li>账号数据存储于运营方控制的数据库，仅授予必要的运维与管理人员访问权限。</li>
          <li>
            音乐平台凭据的云端副本加密保存；会话 Cookie 不允许页面脚本读取，在 HTTPS 下启用 Secure
            属性。
          </li>
          <li>
            互联网传输与存储不存在绝对安全。本站会按合理标准保护信息，但无法承诺信息绝不泄露。
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="四、你的权利">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            目前没有自助导出或删除账号的入口。需要查询、导出、更正或删除与你账号相关的信息，请通过站内反馈联系我们，我们核实账号归属后手动处理；法律法规要求保留的记录除外。
          </li>
          <li>
            你可以随时退出登录。清除浏览器数据会删除本机偏好、匿名访客标识与保存在本机的音乐平台凭据，同时也会失去房间设置记忆。
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="五、未成年人">
        <p>
          本站面向一般用户。未成年人应在监护人同意与指导下使用本站；如监护人发现未成年人未经同意提交了个人信息，可联系我们处理。
        </p>
      </LegalSection>

      <LegalSection title="六、本说明的更新">
        <p>本说明更新后会在此页公布，并更新「最后更新」日期。</p>
      </LegalSection>

      <LegalSection title="七、联系我们">
        <p>
          可以通过站内的「反馈」入口联系我们，游客也能匿名提交，登录后提交的反馈可以在站内看到回复；也可以通过首页页脚列出的社区入口找到运营者。
        </p>
      </LegalSection>
    </>
  );
}
