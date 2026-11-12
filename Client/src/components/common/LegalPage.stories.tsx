import type { Meta, StoryObj } from "@storybook/react-vite";
import { LegalSection } from "./LegalPage";

const meta = {
  title: "公共组件/LegalSection",
  component: LegalSection,
  args: { title: "我们收集的信息", children: null },
} satisfies Meta<typeof LegalSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 条款页的小节：小标题加若干段正文，两节之间的间距由页面给出。 */
export const Sections: Story = {
  name: "两节正文",
  render: () => (
    <article className="w-[36rem] max-w-full space-y-6 rounded-md border bg-card p-6">
      <LegalSection title="我们收集的信息">
        <p>游客游玩只在本机保存昵称与偏好，不上传服务器。</p>
        <p>
          登录后，服务器保存你的账号昵称、头像与房间设置记忆；QQ
          号默认不公开，可在资料设置里自行开启。
        </p>
      </LegalSection>
      <LegalSection title="信息的使用">
        <p>这些信息只用于在房间里显示你的身份、恢复你的设置，不用于广告，也不提供给第三方。</p>
      </LegalSection>
    </article>
  ),
};
