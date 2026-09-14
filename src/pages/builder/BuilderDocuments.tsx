import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Download, FileText, Loader2, Lock, Plus, RefreshCw, ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderScopePicker, type BuilderScopeValue } from '@/components/builder-portal/BuilderScopePicker';
import {
  fetchBuilderDocumentUrl, useBuilderCollaborationMutation, useBuilderDocument,
  useBuilderDocuments,
} from '@/lib/builderQueries';
import {
  DOCUMENT_STATUS_CLASSES, DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS,
  formatCollaborationDate, formatCollaborationTime, formatFileSize, isDocumentRestricted,
  type BuilderDocumentStatus, type BuilderDocumentType, type BuilderScopeType,
} from '@/lib/builderCollaboration';

const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABELS) as BuilderDocumentType[];

/**
 * External Builder Portal documents.
 *
 * The list contains only documents the server decided this user may see: it is
 * built from `builder_accessible_documents`, so a document restricted by a grant
 * simply is not in the response. Nothing here holds a storage path — a download
 * asks the server for a short-lived signed URL, which re-resolves the permission
 * before minting it.
 */
export default function BuilderDocuments() {
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();

  const projectId = params.get('project') ?? '';
  const scope: BuilderScopeValue = {
    scopeType: (params.get('scope') as BuilderScopeType) || 'project',
    scopeId: params.get('scopeId') ?? (params.get('scope') ? '' : projectId),
  };

  const setScope = (next: BuilderScopeValue) => {
    const updated = new URLSearchParams(params);
    if (next.scopeType) updated.set('scope', next.scopeType); else updated.delete('scope');
    if (next.scopeId) updated.set('scopeId', next.scopeId); else updated.delete('scopeId');
    setParams(updated, { replace: true });
    setSelectedId('');
  };
  const setProjectId = (next: string) => {
    const updated = new URLSearchParams(params);
    if (next) updated.set('project', next); else updated.delete('project');
    setParams(updated, { replace: true });
  };

  const [selectedId, setSelectedId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [documentType, setDocumentType] = useState<BuilderDocumentType>('other');

  const query = useBuilderDocuments(scope);
  const detailQuery = useBuilderDocument(selectedId);
  const mutation = useBuilderCollaborationMutation();

  const records = query.data || [];
  const scopeChosen = Boolean(scope.scopeType && scope.scopeId);
  const permissionDenied = (query.error as { status?: number } | null)?.status === 403;

  const createDocument = async () => {
    if (!title.trim()) return;
    try {
      await mutation.mutateAsync({
        operation: 'upsert_document',
        scope_type: scope.scopeType,
        scope_id: scope.scopeId,
        title: title.trim(),
        description: description.trim() || null,
        document_type: documentType,
      });
      toast({ title: 'Document added' });
      setCreateOpen(false);
      setTitle(''); setDescription(''); setDocumentType('other');
    } catch (error) {
      toast({
        title: 'The document could not be added',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const download = async (documentId: string, versionId?: string) => {
    try {
      const { url } = await fetchBuilderDocumentUrl(documentId, versionId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast({
        title: 'The document could not be opened',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <BuilderPortalShell
      title="Documents"
      description="Plans, certificates and packs for the records you have been granted access to."
      actions={
        <>
          <Button
            variant="outline" size="sm"
            onClick={() => void query.refetch()}
            disabled={!scopeChosen || query.isFetching}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!scopeChosen}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />Add document
          </Button>
        </>
      }
    >
      <Card>
        <CardHeader className="gap-3">
          <div>
            <CardTitle className="text-base">Choose what to look at</CardTitle>
            <CardDescription>
              Documents belong to a project, unit, transaction or build. Every option below is
              one your access already reaches.
            </CardDescription>
          </div>
          <BuilderScopePicker
            value={scope} onChange={setScope}
            projectId={projectId} onProjectChange={setProjectId}
          />
        </CardHeader>
        <CardContent>
          {!scopeChosen ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">Choose a record to see its documents</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick a project above, then narrow to a unit, transaction or build if you need to.
              </p>
            </div>
          ) : query.isLoading ? (
            <div className="flex justify-center py-14">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading documents" />
            </div>
          ) : permissionDenied ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <ShieldAlert className="mx-auto h-6 w-6 text-destructive" aria-hidden />
              <p className="mt-2 font-medium">You do not have access to these documents</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Ask your administrator to confirm your document access for this record.
              </p>
            </div>
          ) : query.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
              <p className="font-medium">Documents could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">Check your connection and try again.</p>
              <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !records.length ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No documents on this record yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add the first one, or ask your administrator to confirm your document access.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Document</TableHead>
                    <TableHead className="hidden md:table-cell">Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => setSelectedId(record.id)}
                          className="block rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex items-center gap-2 font-medium">
                            <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
                            {record.title}
                          </span>
                          <span className="block max-w-80 truncate text-xs text-muted-foreground">
                            {record.description || 'No description'}
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {DOCUMENT_TYPE_LABELS[record.document_type]}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={DOCUMENT_STATUS_CLASSES[record.status as BuilderDocumentStatus]}
                        >
                          {DOCUMENT_STATUS_LABELS[record.status as BuilderDocumentStatus]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {formatCollaborationDate(record.updated_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost" size="sm"
                          disabled={!record.current_version_id}
                          onClick={() => void download(record.id)}
                        >
                          <Download className="mr-2 h-4 w-4" aria-hidden />Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedId ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {detailQuery.data?.document.title || 'Document'}
            </CardTitle>
            <CardDescription>
              Every version is kept. A version cannot be edited or removed once written.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailQuery.isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label="Loading versions" />
              </div>
            ) : detailQuery.isError ? (
              <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                <p className="font-medium">This document could not be loaded</p>
              </div>
            ) : (
              <>
                {isDocumentRestricted(detailQuery.data?.grants || []) ? (
                  <p className="flex items-center gap-2 rounded-md border border-accent/50 p-3 text-sm">
                    <Lock className="h-4 w-4" aria-hidden />
                    This document is restricted to named people.
                  </p>
                ) : null}
                {!(detailQuery.data?.versions || []).length ? (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="font-medium">No file attached yet</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Version</TableHead>
                          <TableHead>File</TableHead>
                          <TableHead className="hidden md:table-cell">Size</TableHead>
                          <TableHead className="hidden lg:table-cell">Added</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(detailQuery.data?.versions || []).map((version) => (
                          <TableRow key={version.id}>
                            <TableCell className="font-medium">v{version.version_number}</TableCell>
                            <TableCell>
                              <span className="block max-w-64 truncate">{version.file_name}</span>
                              <span className="block max-w-64 truncate text-xs text-muted-foreground">
                                {version.change_note || 'No note'}
                              </span>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              {formatFileSize(version.byte_size)}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {formatCollaborationTime(version.created_at)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost" size="sm"
                                onClick={() => void download(selectedId, version.id)}
                              >
                                <Download className="mr-2 h-4 w-4" aria-hidden />Open
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>
              This records the document. Attach the file as a version once it is uploaded.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="document-title">Title</Label>
              <Input
                id="document-title" value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Frame certificate"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="document-type">Type</Label>
              <Select
                value={documentType}
                onValueChange={(next) => setDocumentType(next as BuilderDocumentType)}
              >
                <SelectTrigger id="document-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>{DOCUMENT_TYPE_LABELS[type]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="document-description">Description</Label>
              <Textarea
                id="document-description" value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this document covers"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void createDocument()} disabled={!title.trim() || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Add document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BuilderPortalShell>
  );
}
