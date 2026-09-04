export const metadata = { title: "Next.js + forge-orm + PGlite" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
        {children}
      </body>
    </html>
  )
}
