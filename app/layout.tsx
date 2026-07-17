import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PO Extractor",
  description:
    "Upload a fabric purchase-order PDF and receive a clean, ERP-ready CSV in seconds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
