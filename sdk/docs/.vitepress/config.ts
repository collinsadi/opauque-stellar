import { defineConfig } from "vitepress";
import typedocSidebar from "../api/typedoc-sidebar.json";

export default defineConfig({
  title: "@opaquecash/stellar",
  description:
    "Stealth private payments, privacy pools, relayer-market submission, and on-chain ZK reputation for Stellar / Soroban.",
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/stealth-payments" },
      { text: "Integrate", link: "/integrate/private-payments" },
      { text: "API", link: "/api/" },
    ],
    sidebar: {
      "/api/": [{ text: "API Reference", items: typedocSidebar }],
      "/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Node (server keypair)", link: "/guide/node" },
            { text: "Browser (Freighter)", link: "/guide/browser" },
          ],
        },
        {
          text: "Integration walkthroughs",
          items: [
            { text: "Private Payments", link: "/integrate/private-payments" },
            { text: "Privacy Pool", link: "/integrate/privacy-pool" },
            { text: "ZK Reputation", link: "/integrate/reputation" },
            { text: "Relayer Market", link: "/integrate/relayer-market" },
          ],
        },
        {
          text: "Concepts",
          items: [
            { text: "Stealth Payments", link: "/concepts/stealth-payments" },
            { text: "ZK Reputation", link: "/concepts/zk-reputation" },
            { text: "Privacy Pool", link: "/concepts/privacy-pool" },
            { text: "Relayer Market", link: "/concepts/relayer-market" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "OpaqueClient", link: "/reference/client" },
            { text: "Security Model", link: "/reference/security" },
            { text: "Versioning & Deprecation", link: "/reference/versioning" },
            { text: "Full API", link: "/api/" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/collinsadi/opauque-stellar" },
    ],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Opaque Cash",
    },
  },
});
