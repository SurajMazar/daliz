import { Check, Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { copyText, downloadText } from '@/lib/utils';

/** Recovery codes are shown exactly once. The user must confirm they've saved them. */
export function RecoveryCodes({ codes, email, onDone, doneLabel = 'Continue' }: { codes: string[]; email: string; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Daliz recovery codes for ${email}\nGenerated ${new Date().toISOString()}\nEach code can be used once.\n\n${codes.join('\n')}\n`;

  return (
    <div className="grid gap-4">
      <Alert variant="warning" title="Save these recovery codes now">
        They’re the only way into your account if you lose your authenticator. You won’t be able to see them again.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/50 p-4 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            if (await copyText(codes.join('\n'))) {
              setCopied(true);
              toast.success('Recovery codes copied');
              setTimeout(() => setCopied(false), 2000);
            } else toast.error('Couldn’t copy. Select the codes and copy them manually.');
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => downloadText('daliz-recovery-codes.txt', text)}>
          <Download /> Download .txt
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="codes-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        <Label htmlFor="codes-saved" className="font-normal">
          I’ve saved my recovery codes somewhere safe
        </Label>
      </div>
      <Button onClick={onDone} disabled={!saved}>
        {doneLabel}
      </Button>
    </div>
  );
}
