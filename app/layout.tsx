import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VolForge AI",
  description: "Autonomous options intelligence and paper-trading control room.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
