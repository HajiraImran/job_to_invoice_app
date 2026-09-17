import type { ReactNode } from "react";

export const metadata = {
  title: "Job to Invoice",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <style>{`
          body { margin: 0; font-family: system-ui, sans-serif; background: #f6f3ee; color: #14213d; }
          .portal { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; display: flex; flex-direction: column; gap: 16px; }
          button, input, textarea { min-height: 44px; font-size: 16px; }
          label { display: flex; flex-direction: column; gap: 8px; }
        `}</style>
        {children}
      </body>
    </html>
  );
}
