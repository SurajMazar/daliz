import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  checkThemeContrast,
  rgbToHex,
  themeInputSchema,
  type LogoAnalysis,
  type LogoVariant,
  type ThemeInput,
} from '@daliz/shared';
import { CircleCheck, CircleX, ImageOff, RotateCcw, Sparkles, TriangleAlert, Wand } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { ColorInput } from '@/components/ui/color-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileDropzone } from '@/components/ui/file-dropzone';
import { FormField } from '@/components/ui/form-field';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, isApiError } from '@/lib/api';
import { useAccess } from '@/lib/session';
import { cn } from '@/lib/utils';
import { brandingKeys, useTenantBranding, type TenantBranding } from './api';
import { ThemePreview } from './theme-preview';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

type ColorKey = 'primary' | 'secondary' | 'accent' | 'background' | 'foreground';
const COLOR_FIELDS: { key: ColorKey; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, links, focus rings' },
  { key: 'secondary', label: 'Secondary', hint: 'Secondary buttons and surfaces' },
  { key: 'accent', label: 'Accent', hint: 'Highlights and tags' },
  { key: 'background', label: 'Background', hint: 'Page background (light mode)' },
  { key: 'foreground', label: 'Text', hint: 'Body text (light mode)' },
];

const VARIANTS: { key: LogoVariant; label: string; box: string; dark?: boolean }[] = [
  { key: 'header', label: 'Header', box: 'h-16 col-span-2' },
  { key: 'sidebar', label: 'Sidebar', box: 'h-16 col-span-2' },
  { key: 'login', label: 'Login', box: 'h-24 col-span-2' },
  { key: 'email', label: 'Email', box: 'h-16 col-span-2' },
  { key: 'mobile', label: 'Mobile', box: 'h-20' },
  { key: 'icon-512', label: 'App icon 512', box: 'h-20' },
  { key: 'icon-192', label: 'App icon 192', box: 'h-20' },
  { key: 'icon-180', label: 'Apple touch 180', box: 'h-20' },
  { key: 'favicon-48', label: 'Favicon 48', box: 'h-14' },
  { key: 'favicon-32', label: 'Favicon 32', box: 'h-14' },
  { key: 'favicon-16', label: 'Favicon 16', box: 'h-14' },
];

interface Draft {
  theme: ThemeInput;
  logoAssetId: string | null;
  logoUrls: Partial<Record<LogoVariant, string>>;
  loginMessage: string;
}

function initialDraft(b: TenantBranding): Draft {
  return {
    theme: b.theme,
    logoAssetId: b.logoAssetId,
    logoUrls: b.logo?.urls ?? {},
    loginMessage: b.loginMessage ?? '',
  };
}

export function BrandingPage() {
  const { me } = useAccess();
  const branding = useTenantBranding(me.tenant?.id);

  if (branding.isPending) {
    return (
      <>
        <PageHeader title="Branding" description="Your logo, colors and sign-in page." />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </>
    );
  }
  if (branding.isError) {
    return (
      <>
        <PageHeader title="Branding" />
        <Card>
          <ErrorState error={branding.error} onRetry={() => void branding.refetch()} />
        </Card>
      </>
    );
  }
  return <BrandingEditor key={branding.data.version} branding={branding.data} />;
}

function BrandingEditor({ branding }: { branding: TenantBranding }) {
  const { me, canWrite } = useAccess();
  const qc = useQueryClient();
  const editable = canWrite('branding.update');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(branding));
  const [analysis, setAnalysis] = useState<LogoAnalysis | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const name = me.tenant?.settings.displayName || me.tenant?.name || branding.name;

  const themeValid = themeInputSchema.safeParse(draft.theme).success;
  const checks = useMemo(() => (themeValid ? checkThemeContrast(draft.theme) : []), [draft.theme, themeValid]);
  const blocking = checks.filter((c) => c.severity === 'error' && !c.passes);
  const warnings = checks.filter((c) => c.severity === 'warning' && !c.passes);

  const initial = useMemo(() => initialDraft(branding), [branding]);
  const dirty =
    JSON.stringify(draft.theme) !== JSON.stringify(initial.theme) ||
    draft.logoAssetId !== initial.logoAssetId ||
    draft.loginMessage.trim() !== initial.loginMessage.trim();

  const setTheme = (patch: Partial<ThemeInput>) => setDraft((d) => ({ ...d, theme: { ...d.theme, ...patch } }));

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<LogoAnalysis>('/branding/logo', form, { silent: false });
    },
    meta: { silent: true },
    onMutate: () => setUploadError(null),
    onSuccess: (a) => {
      setAnalysis(a);
      setDraft((d) => ({ ...d, logoAssetId: a.uploadId, logoUrls: a.previewUrls }));
      toast.success('Logo uploaded', { description: 'Review the previews and palette, then save to publish it.' });
    },
    onError: (e) => setUploadError(isApiError(e) ? e.message : 'The upload failed. Try again.'),
  });

  const save = useMutation({
    mutationFn: () =>
      api.put<TenantBranding>(
        '/branding',
        {
          theme: draft.theme,
          logoAssetId: draft.logoAssetId,
          loginMessage: draft.loginMessage.trim() ? draft.loginMessage.trim() : null,
          version: branding.version,
        },
        {},
      ),
    meta: { silent: true },
    onMutate: () => setSaveErrors([]),
    onSuccess: (saved) => {
      // Re-applies the theme, logo and favicon app-wide via the tenant shell.
      qc.setQueryData(brandingKeys.tenant(me.tenant?.id), saved);
      void qc.invalidateQueries({ queryKey: brandingKeys.public });
      toast.success('Branding published', { description: 'Everyone in the workspace now sees the new look.' });
    },
    onError: (e) => {
      if (isApiError(e)) {
        if (e.code === 'VERSION_CONFLICT') {
          setSaveErrors([e.message]);
          return;
        }
        setSaveErrors(e.details.length ? e.details.map((d) => d.message) : [e.message]);
      } else setSaveErrors(['Saving failed. Try again.']);
    },
  });

  const palette = analysis?.palette.map((rgb) => rgbToHex(rgb)) ?? [];
  const hasLogo = !!draft.logoAssetId;
  const logos = hasLogo ? { header: draft.logoUrls.header, sidebar: draft.logoUrls.sidebar, login: draft.logoUrls.login } : {};

  return (
    <>
      <PageHeader
        title="Branding"
        description="Upload your logo, pick colors and preview the result in light and dark mode before publishing it to everyone."
        actions={
          editable ? (
            <>
              <Button
                variant="outline"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setDraft(initial);
                  setAnalysis(null);
                  setSaveErrors([]);
                }}
              >
                <RotateCcw /> Discard
              </Button>
              <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || blocking.length > 0 || !themeValid}>
                Save and publish
              </Button>
            </>
          ) : null
        }
      />

      {!editable ? (
        <Alert variant="info" title="View only" className="mb-6">
          You can view this workspace’s branding but not change it.
        </Alert>
      ) : null}
      {saveErrors.length ? (
        <Alert variant="destructive" title="Couldn’t save branding" className="mb-6">
          <ul className="list-disc pl-4">
            {saveErrors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        {/* Left column: editing */}
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Logo</CardTitle>
              <CardDescription>PNG, JPEG, WebP or SVG up to 2 MB. We generate every size you need and extract your brand colors.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {editable ? (
                <FileDropzone
                  accept={LOGO_TYPES}
                  maxBytes={LOGO_MAX_BYTES}
                  busy={upload.isPending}
                  onFile={(f) => upload.mutate(f)}
                  onReject={setUploadError}
                  title="Drop your logo here, or click to browse"
                  hint="A wide logo on a transparent background works best."
                />
              ) : null}
              {uploadError ? <Alert variant="destructive" title={uploadError} /> : null}
              {analysis?.warnings.length ? (
                <Alert variant="warning" title="Things to check">
                  <ul className="list-disc pl-4">
                    {analysis.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              {analysis ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {analysis.width}×{analysis.height}px
                  </span>
                  <span>{analysis.format.toUpperCase()}</span>
                  <span>Aspect {analysis.aspectRatio}:1</span>
                  <span>{analysis.hasTransparency ? 'Transparent background' : 'Opaque background'}</span>
                </div>
              ) : null}

              {hasLogo ? (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between">
                    <Label>Generated sizes {analysis ? <Badge variant="info">Not published yet</Badge> : null}</Label>
                    {editable ? (
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(true)}>
                        <ImageOff /> Remove logo
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                    {VARIANTS.map((v) => {
                      const url = draft.logoUrls[v.key];
                      if (!url) return null;
                      return (
                        <figure key={v.key} className={cn('grid gap-1.5', v.box.includes('col-span-2') ? 'col-span-3' : 'col-span-1')}>
                          <div className="grid grid-cols-2 overflow-hidden rounded-md border">
                            <div className={cn('flex items-center justify-center bg-white p-2', v.box.split(' ')[0])}>
                              <img src={url} alt={`${v.label} logo on light background`} className="max-h-full max-w-full object-contain" />
                            </div>
                            <div className={cn('flex items-center justify-center bg-slate-900 p-2', v.box.split(' ')[0])}>
                              <img src={url} alt={`${v.label} logo on dark background`} className="max-h-full max-w-full object-contain" />
                            </div>
                          </div>
                          <figcaption className="truncate text-[11px] text-muted-foreground">{v.label}</figcaption>
                        </figure>
                      );
                    })}
                  </div>
                </div>
              ) : !editable ? (
                <p className="text-sm text-muted-foreground">No logo has been uploaded.</p>
              ) : null}
            </CardContent>
          </Card>

          {analysis ? (
            <Card>
              <CardHeader>
                <CardTitle>Colors from your logo</CardTitle>
                <CardDescription>Click a swatch to use it for a theme color, or apply the suggested theme — it’s already adjusted for accessible contrast.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex flex-wrap gap-2" role="list" aria-label="Extracted palette">
                  {palette.map((hex, i) => (
                    <div role="listitem" key={`${hex}-${i}`}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild disabled={!editable}>
                          <button
                            type="button"
                            className="group grid gap-1 rounded-lg p-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Swatch ${hex}${i === 0 ? ' (dominant)' : ''}. Choose where to use it`}
                          >
                            <span className="block size-12 rounded-md border shadow-xs" style={{ backgroundColor: hex }} />
                            <span className="font-mono text-[10px] text-muted-foreground uppercase">{hex}</span>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-44">
                          <DropdownMenuLabel>Use {hex.toUpperCase()} as…</DropdownMenuLabel>
                          {COLOR_FIELDS.map((f) => (
                            <DropdownMenuItem key={f.key} onSelect={() => setTheme({ [f.key]: hex })}>
                              <span className="size-3 rounded-sm border" style={{ backgroundColor: draft.theme[f.key] }} aria-hidden />
                              {f.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
                  <div className="flex gap-1" aria-hidden>
                    {(['primary', 'secondary', 'accent', 'background', 'foreground'] as const).map((k) => (
                      <span key={k} className="size-6 rounded-md border" style={{ backgroundColor: analysis.suggestedTheme[k] }} />
                    ))}
                  </div>
                  <span className="flex-1 text-sm text-muted-foreground">Suggested theme</span>
                  <Button size="sm" variant="secondary" disabled={!editable} onClick={() => setTheme({ ...analysis.suggestedTheme, defaultMode: draft.theme.defaultMode, radius: draft.theme.radius })}>
                    <Wand /> Use suggested theme
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Theme</CardTitle>
              <CardDescription>Dark mode is derived automatically from your primary color.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {COLOR_FIELDS.map((f) => (
                <FormField key={f.key} label={f.label} hint={f.hint} id={`color-${f.key}`}>
                  <ColorInput label={f.label} value={draft.theme[f.key]} onChange={(hex) => setTheme({ [f.key]: hex })} disabled={!editable} />
                </FormField>
              ))}
              <div className="grid gap-2">
                <Label htmlFor="radius">Corner radius</Label>
                <Select value={draft.theme.radius} onValueChange={(v) => setTheme({ radius: v as ThemeInput['radius'] })} disabled={!editable}>
                  <SelectTrigger id="radius">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Square</SelectItem>
                    <SelectItem value="sm">Small</SelectItem>
                    <SelectItem value="md">Medium</SelectItem>
                    <SelectItem value="lg">Large</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="default-mode">Default appearance</Label>
                <Select value={draft.theme.defaultMode} onValueChange={(v) => setTheme({ defaultMode: v as ThemeInput['defaultMode'] })} disabled={!editable}>
                  <SelectTrigger id="default-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">Follow device setting</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sign-in page</CardTitle>
              <CardDescription>A short message shown under your logo on the sign-in page.</CardDescription>
            </CardHeader>
            <CardContent>
              <FormField label="Sign-in message" hint={`${draft.loginMessage.length}/280 characters`}>
                <Textarea
                  rows={3}
                  maxLength={280}
                  disabled={!editable}
                  placeholder="Welcome to the Acme finance portal. Need help? Contact it@acme.example"
                  value={draft.loginMessage}
                  onChange={(e) => setDraft((d) => ({ ...d, loginMessage: e.target.value }))}
                />
              </FormField>
            </CardContent>
          </Card>
        </div>

        {/* Right column: preview + contrast */}
        <div className="grid content-start gap-6 xl:sticky xl:top-20">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden /> Live preview
              </CardTitle>
              <CardDescription>Only this preview changes until you save.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {themeValid ? (
                <>
                  <ThemePreview theme={draft.theme} mode="light" name={name} logos={logos} loginMessage={draft.loginMessage} />
                  <ThemePreview theme={draft.theme} mode="dark" name={name} logos={logos} loginMessage={draft.loginMessage} />
                </>
              ) : (
                <Alert variant="warning" title="Enter valid hex colors to see the preview" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Accessibility check</CardTitle>
              <CardDescription>WCAG 2.2 AA contrast. Failing required checks block saving; warnings are advisory.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 pb-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Check</TableHead>
                    <TableHead className="text-right">Ratio</TableHead>
                    <TableHead className="text-right">Needs</TableHead>
                    <TableHead className="text-right">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-6 w-9 shrink-0 items-center justify-center rounded border text-[11px] font-semibold"
                            style={{ backgroundColor: c.background, color: c.foreground }}
                            aria-hidden
                          >
                            Aa
                          </span>
                          <span className="text-sm">{c.label}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{c.ratio.toFixed(2)}:1</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">{c.required}:1</TableCell>
                      <TableCell className="text-right">
                        {c.passes ? (
                          <Badge variant="success">
                            <CircleCheck /> Pass
                          </Badge>
                        ) : c.severity === 'error' ? (
                          <Badge variant="destructive">
                            <CircleX /> Fail
                          </Badge>
                        ) : (
                          <Badge variant="warning">
                            <TriangleAlert /> Warn
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
            <CardFooter className="text-sm" aria-live="polite">
              {!themeValid ? (
                <span className="text-muted-foreground">Fix invalid colors to run the checks.</span>
              ) : blocking.length ? (
                <span className="font-medium text-destructive">
                  {blocking.length} required check{blocking.length === 1 ? '' : 's'} failing — adjust your colors to save.
                </span>
              ) : (
                <span className="text-success">
                  All required checks pass{warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}.
                </span>
              )}
            </CardFooter>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the logo?"
        description="The workspace name will be shown instead. This takes effect when you save."
        confirmLabel="Remove logo"
        destructive
        onConfirm={() => {
          setDraft((d) => ({ ...d, logoAssetId: null, logoUrls: {} }));
          setAnalysis(null);
        }}
      />
    </>
  );
}
