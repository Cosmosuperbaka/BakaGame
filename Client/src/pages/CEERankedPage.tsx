import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { CEE_RANKED_PLACEMENT_SERIES } from "@bakagame/shared/values";
import { Seo } from "@/components/common/Seo";
import { SettingsEntry } from "@/components/settings/SettingsEntry";
import { Button } from "@/components/ui/Button";
import { CEERankedGameRecap } from "@/components/cee/ranked/CEERankedGameRecap";
import { CEERankedGate } from "@/components/cee/ranked/CEERankedGate";
import { CEERankedHome } from "@/components/cee/ranked/CEERankedHome";
import { CEERankedMatch } from "@/components/cee/ranked/CEERankedMatch";
import { CEERankedResultCard } from "@/components/cee/ranked/CEERankedResultCard";
import { CEERankedScoreboard } from "@/components/cee/ranked/CEERankedScoreboard";
import { CEEDataSourceContext, rankedCEEDataSource } from "@/lib/CEEDataSource";
import { isBakaClient, setSecureScreen } from "@/lib/BakaChannel";
import { dropIn, phaseSwap } from "@/lib/Motion";
import { useAccountStore, type AccountStatus } from "@/stores/UseAccountStore";
import { useCEEStore } from "@/stores/UseCEEStore";
import { useCEERankedStore } from "@/stores/UseCEERankedStore";

/** 排位系列赛的主体：顶栏比分常驻，下面按阶段换成对局、局间复盘或结算。 */
function RankedSeriesStage() {
  const state = useCEERankedStore((store) => store.state);
  const pending = useCEERankedStore((store) => store.pending);
  const series = state?.status === "series" ? state.series : null;
  // 系列赛进行中挡录屏：与反作弊房同一口径，结束或离开即恢复。
  const live = Boolean(series && series.phase !== "settled");
  useEffect(() => {
    setSecureScreen(live);
    return () => setSecureScreen(false);
  }, [live]);
  if (!series) return null;
  const store = useCEERankedStore.getState();
  const last = series.games.at(-1);
  const stage =
    series.phase === "settled" ? "settled" : series.phase === "intermission" ? "recap" : "play";
  return (
    <div className="space-y-4">
      <CEERankedScoreboard series={series} />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={
            stage === "play"
              ? `play-${series.game?.number ?? 0}`
              : `${stage}-${series.games.length}`
          }
          variants={phaseSwap}
          initial="initial"
          animate="animate"
          exit="exit"
          className="space-y-6"
        >
          {stage === "settled" ? (
            <>
              <CEERankedResultCard
                series={series}
                placementTotal={CEE_RANKED_PLACEMENT_SERIES}
                requeueing={Boolean(pending.queue)}
                leaving={Boolean(pending.leave)}
                onRequeue={() => void store.queue()}
                onLeave={() => void store.leave()}
              />
              {[...series.games].reverse().map((game) => (
                <CEERankedGameRecap key={game.number} game={game} />
              ))}
            </>
          ) : stage === "recap" && last ? (
            <CEERankedGameRecap game={last} reveal />
          ) : (
            <CEEDataSourceContext.Provider value={rankedCEEDataSource}>
              <CEERankedMatch
                series={series}
                pending={pending}
                onGuess={(characterId) => store.guess(characterId)}
                onSurrender={() => void store.surrender()}
                onExit={() => void store.exit()}
              />
            </CEEDataSourceContext.Provider>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** 排位首页：分数、匹配与最近战绩；首页与系列赛之间由服务端推来的状态切换。 */
function RankedHomeStage() {
  const state = useCEERankedStore((store) => store.state);
  const profile = useCEERankedStore((store) => store.profile);
  const pending = useCEERankedStore((store) => store.pending);
  useEffect(() => {
    void useCEERankedStore.getState().loadProfile();
  }, []);
  if (!state || state.status === "series") return null;
  const store = useCEERankedStore.getState();
  return (
    <CEERankedHome
      profile={profile}
      state={state}
      placementTotal={CEE_RANKED_PLACEMENT_SERIES}
      pending={pending}
      onQueue={() => void store.queue()}
      onCancel={() => void store.cancel()}
      onPlayBot={() => void store.playBot()}
    />
  );
}

/**
 * 排位赛页。网页端只给客户端下载说明；客户端未登录引导登录；
 * 其余由服务端推送的排位状态驱动（空闲 / 排队 / 系列赛），页面不自行推断准入。
 */
export default function CEERankedPage() {
  const navigate = useNavigate();
  const accountStatus = useAccountStore((state) => state.status);
  const connected = useCEEStore((state) => state.connected);
  const ready = useCEERankedStore((state) => state.ready);
  const inSeries = useCEERankedStore((state) => state.state?.status === "series");
  const client = isBakaClient();
  const eligible = client && accountStatus === "signedIn";
  useEffect(() => {
    if (!eligible || !connected) return;
    return useCEERankedStore.getState().attach();
  }, [eligible, connected]);

  return (
    <div className="scrollbar-hidden flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto">
      <Seo
        path="/cee/ranked"
        description="二刺猿笑传之猜猜呗排位赛：三局两胜同题竞速，按分数匹配对手与题库难度。"
        indexable={false}
      />
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 pb-4 pt-6 md:px-10 md:pt-8">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
            disabled={inSeries}
            onClick={() => void navigate("/")}
          >
            <ArrowLeft className="h-4 w-4" />
            <span>返回主页</span>
          </Button>
          <div className="h-4 w-px shrink-0 bg-border" />
          <h1 className="flex min-w-0 items-center gap-2 text-lg font-bold sm:text-2xl">
            <span className="min-w-0 truncate">排位赛</span>
            <span className="hidden shrink-0 self-end pb-0.5 text-xs font-medium text-muted-foreground sm:inline sm:pb-1 sm:text-sm">
              二刺猿笑传之猜猜呗
            </span>
          </h1>
          <div className="ml-auto flex shrink-0 items-center">
            <SettingsEntry />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-10 pt-6 sm:px-6 md:px-10">
        <RankedBody
          client={client}
          accountStatus={accountStatus}
          ready={ready}
          inSeries={inSeries}
        />
      </main>
    </div>
  );
}

/** 正文按准入与连接状态分支：门槛说明、连接中占位、首页或系列赛。 */
function RankedBody({
  client,
  accountStatus,
  ready,
  inSeries,
}: {
  client: boolean;
  accountStatus: AccountStatus;
  ready: boolean;
  inSeries: boolean;
}) {
  const promptLogin = () => useCEEStore.getState().promptLogin();
  if (!client) return <CEERankedGate reason="client" onLogin={promptLogin} />;
  if (accountStatus === "loading") return null;
  if (accountStatus !== "signedIn") return <CEERankedGate reason="login" onLogin={promptLogin} />;
  if (!ready)
    return (
      <div
        className="h-40 rounded-md bg-muted motion-safe:animate-breathe"
        aria-label="正在连接排位"
      />
    );
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.div
        key={inSeries ? "series" : "home"}
        variants={dropIn}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        {inSeries ? <RankedSeriesStage /> : <RankedHomeStage />}
      </motion.div>
    </AnimatePresence>
  );
}
