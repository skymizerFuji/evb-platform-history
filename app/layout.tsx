import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Platform-EVB-DVB lookup table",
  description: "Track platform changes for each EVB over time. Select an EVB to view its history and records.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
