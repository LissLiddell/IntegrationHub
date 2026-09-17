import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IntegrationHub | Event operations",
  description: "Control de webhooks, entregas, intentos y reintentos para Nébula Commerce.",
  icons: { icon: "/favicon.svg" }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
