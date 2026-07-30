import './globals.css';

export const metadata = {
  title: 'WealthWire — try it with your own order sheet',
  description:
    'Upload an order sheet, watch it validate, and take it all the way to confirm and route. A live demo of WealthWire, the FIX order manager for independent Swiss wealth managers.',
  metadataBase: new URL('https://wealthwire.app'),
  openGraph: {
    title: 'WealthWire — try it with your own order sheet',
    description: 'Upload, validate, confirm and route. No sign-in.',
    url: 'https://wealthwire.app',
    siteName: 'WealthWire',
    locale: 'en_CH',
    type: 'website',
  },
};

export const viewport = { themeColor: '#070B12' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Epunda+Sans:ital,wght@0,300..900;1,300..900&family=Epunda+Slab:ital,wght@0,300..900;1,300..900&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16" />
        <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
      </head>
      <body>{children}</body>
    </html>
  );
}
