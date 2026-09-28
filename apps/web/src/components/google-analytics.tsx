export function GoogleAnalytics({ measurementId }: { readonly measurementId: string }) {
  const script = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${measurementId}');`;
  return (
    <>
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} />
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </>
  );
}
