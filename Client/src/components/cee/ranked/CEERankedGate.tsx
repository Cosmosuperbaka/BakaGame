import { Download, LogIn, MonitorSmartphone } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { BAKA_CLIENT_DOWNLOAD_URL } from "@/lib/AntiCheatCopy";

/**
 * 排位的门槛说明：网页端只说明「需要客户端」并给下载入口，客户端未登录时引导登录。
 * 这里只是展示，真正的准入由服务端判定。
 */
export function CEERankedGate({
  reason,
  onLogin,
}: {
  reason: "client" | "login";
  onLogin: () => void;
}) {
  return (
    <section
      aria-label="排位赛准入"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border bg-card px-6 py-10 text-center shadow-sm"
    >
      <MonitorSmartphone className="size-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="font-serif text-xl font-semibold">
        {reason === "client" ? "排位赛只在客户端开放" : "登录后参加排位赛"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {reason === "client"
          ? "排位需要使用 BakaGame 客户端并登录账号，下载安装后从客户端进入。"
          : "排位分与战绩记在账号上，登录后即可开始定级赛。"}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {reason === "client" ? (
          <Button asChild>
            <a href={BAKA_CLIENT_DOWNLOAD_URL} rel="noopener">
              <Download aria-hidden="true" />
              下载客户端
            </a>
          </Button>
        ) : (
          <Button onClick={onLogin}>
            <LogIn aria-hidden="true" />
            登录
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to="/cee">返回多人模式</Link>
        </Button>
      </div>
    </section>
  );
}
