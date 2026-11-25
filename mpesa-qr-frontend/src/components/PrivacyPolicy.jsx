import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Zap } from 'lucide-react';

const PrivacyPolicy = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen w-full bg-white dark:bg-zinc-950 text-zinc-950 dark:text-white">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-zinc-200 dark:border-zinc-800 backdrop-blur-xl bg-white/90 dark:bg-zinc-950/90">
        <div className="max-w-4xl mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
          <div
            className="flex items-center gap-2 cursor-pointer group"
            onClick={() => navigate('/')}
          >
            <div className="bg-brand-orange p-1.5 rounded-lg shadow-md group-hover:scale-105 transition-transform">
              <Zap className="w-4 h-4 text-zinc-950 fill-current" />
            </div>
            <span className="text-lg font-black tracking-tighter uppercase italic dark:text-white">
              Merchant<span className="text-brand-orange">Pro</span>
            </span>
          </div>

          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-zinc-500 hover:text-brand-orange transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
        </div>
      </nav>

      {/* PDF Viewer */}
      <main className="max-w-4xl mx-auto px-4 md:px-6 py-10">
        <h1 className="text-3xl md:text-4xl font-black uppercase italic tracking-tighter mb-2">
          Privacy <span className="text-brand-orange">Policy</span>
        </h1>
        <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-8">
          M-Pesa QR Code Generator — Cloudora Ltd.
        </p>

        {/* Embedded PDF — fills the viewport height so the user can scroll inside it */}
        <div className="w-full rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-xl">
          <iframe
            src="/privacy-policy.pdf"
            title="Privacy Policy"
            className="w-full"
            style={{ height: '80vh', minHeight: '600px' }}
          />
        </div>

        {/* Fallback download link */}
        <p className="mt-6 text-center text-sm text-zinc-500">
          Can't see the document?{' '}
          <a
            href="/privacy-policy.pdf"
            download
            className="font-black text-brand-orange hover:underline"
          >
            Download Privacy Policy PDF
          </a>
        </p>
      </main>

      {/* Minimal footer */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800 py-8 mt-10">
        <div className="max-w-4xl mx-auto px-4 md:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            © 2026 Cloudora Ltd. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <a
              href="/privacy-policy"
              className="text-[10px] font-black uppercase tracking-widest text-brand-orange hover:underline"
            >
              Privacy Policy
            </a>
            <a
              href="/terms-and-conditions"
              className="text-[10px] font-black uppercase tracking-widest text-zinc-500 hover:text-brand-orange transition-colors"
            >
              Terms &amp; Conditions
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default PrivacyPolicy;
