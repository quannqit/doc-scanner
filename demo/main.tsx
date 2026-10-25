import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toPdf } from '../src/index.js';
import { DocumentScanner, viLabels, type ScannedPage } from '../src/react/index.js';

const vi = new URLSearchParams(location.search).get('lang') === 'vi';

function App() {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<ScannedPage[]>([]);

  const downloadPdf = async () => {
    const url = URL.createObjectURL(await toPdf(pages.map((p) => p.canvas)));
    Object.assign(document.createElement('a'), { href: url, download: 'scan.pdf' }).click();
  };

  return (
    <>
      <h1>doc-scanner</h1>
      <p>Scan a document with the camera, or pick a photo. Everything runs in the browser.</p>
      <p>
        <button className="primary" onClick={() => setOpen(true)}>Scan document</button>{' '}
        {pages.length > 0 && <button onClick={downloadPdf}>Download PDF ({pages.length})</button>}{' '}
        <a href={vi ? '?' : '?lang=vi'}>{vi ? 'English' : 'Tiếng Việt'}</a>
      </p>
      <div className="pages">
        {pages.map((p) => (
          <a key={p.file.name + p.width} href={URL.createObjectURL(p.file)} target="_blank" rel="noreferrer">
            <img src={URL.createObjectURL(p.file)} alt={p.file.name} />
          </a>
        ))}
      </div>
      {open && (
        <DocumentScanner
          labels={vi ? viLabels : undefined}
          onCancel={() => setOpen(false)}
          onDone={(ps) => {
            setPages((cur) => [...cur, ...ps]);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
