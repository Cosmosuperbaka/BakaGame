import { LogIn, MonitorSmartphone } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";

/**
 * 排位的登录门槛：战绩与排位分记在账号上，未登录时只引导登录。
 * 网页端登录后能查看自己的战绩与排行榜、但对局要在客户端里打，说明里一并交代。
 * 这里只是展示，真正的准入由服务端判定。
 */
export function CEERankedGate({ client, onLogin }: { client: boolean; onLogin: () => void }) {
  return (
    <section
      aria-label="排位赛准入"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border bg-card px-6 py-10 text-center shadow-sm"
    >
      <MonitorSmartphone className="size-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="font-serif text-xl font-semibold">
        {client ? "登录后参加排位赛" : "登录后查看排位战绩"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {client
          ? "排位分与战绩记在账号上，登录后即可开始定级赛。"
          : "排位分与战绩记在账号上，登录后可以查看自己的战绩与排行榜；参加排位需要使用 BakaGame 客户端。"}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onLogin}>
          <LogIn aria-hidden="true" />
          登录
        </Button>
        <Button variant="outline" asChild>
          <Link to="/cee" viewTransition>
            返回多人模式
          </Link>
        </Button>
      </div>
    </section>
  );
}
