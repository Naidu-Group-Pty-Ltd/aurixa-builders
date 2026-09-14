import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ListChecks, Loader2, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BuilderPortalShell } from '@/components/builder-portal/BuilderPortalShell';
import { BuilderScopePicker, type BuilderScopeValue } from '@/components/builder-portal/BuilderScopePicker';
import {
  useBuilderCollaborationMutation, useBuilderMyTasks, useBuilderScopedTasks,
} from '@/lib/builderQueries';
import {
  TASK_PRIORITY_CLASSES, TASK_PRIORITY_LABELS, TASK_STATUS_CLASSES, TASK_STATUS_LABELS,
  formatCollaborationDate, isTaskOverdue,
  type BuilderScopeType, type BuilderTask, type BuilderTaskPriority, type BuilderTaskStatus,
} from '@/lib/builderCollaboration';

const PRIORITIES = Object.keys(TASK_PRIORITY_LABELS) as BuilderTaskPriority[];
const STATUSES = Object.keys(TASK_STATUS_LABELS) as BuilderTaskStatus[];

function TaskTable({
  tasks, onStatusChange, busy,
}: {
  tasks: BuilderTask[];
  onStatusChange?: (task: BuilderTask, status: BuilderTaskStatus) => void;
  busy?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Priority</TableHead>
            <TableHead className="hidden lg:table-cell">Due</TableHead>
            {onStatusChange ? <TableHead className="text-right">Move to</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.id}>
              <TableCell>
                <span className="flex items-center gap-2 font-medium">
                  {task.title}
                  {isTaskOverdue(task) ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-label="Overdue" />
                  ) : null}
                </span>
                <span className="block max-w-80 truncate text-xs text-muted-foreground">
                  {task.description || 'No description'}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={TASK_STATUS_CLASSES[task.status]}>
                  {TASK_STATUS_LABELS[task.status]}
                </Badge>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Badge variant="outline" className={TASK_PRIORITY_CLASSES[task.priority]}>
                  {TASK_PRIORITY_LABELS[task.priority]}
                </Badge>
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                {formatCollaborationDate(task.due_date)}
              </TableCell>
              {onStatusChange ? (
                <TableCell className="text-right">
                  <Select
                    value={task.status}
                    onValueChange={(next) => onStatusChange(task, next as BuilderTaskStatus)}
                    disabled={busy}
                  >
                    <SelectTrigger className="ml-auto w-40" aria-label={`Change status of ${task.title}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>{TASK_STATUS_LABELS[status]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * External Builder Portal tasks.
 *
 * Two views over the same server-decided set: everything assigned to me across
 * every project I can still reach, and everything on one chosen record. Both
 * come from `builder_accessible_tasks`, so a task in a project whose access was
 * revoked disappears from both without any client-side filtering.
 *
 * A status change carries `expected_version`, so two people moving the same task
 * cannot silently overwrite each other — the second attempt is refused.
 */
export default function BuilderTasks() {
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();

  const projectId = params.get('project') ?? '';
  const scope: BuilderScopeValue = {
    scopeType: (params.get('scope') as BuilderScopeType) || 'project',
    scopeId: params.get('scopeId') ?? (params.get('scope') ? '' : projectId),
  };

  const patchParams = (changes: Record<string, string | null>) => {
    const updated = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) updated.set(key, value); else updated.delete(key);
    }
    setParams(updated, { replace: true });
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<BuilderTaskPriority>('normal');
  const [dueDate, setDueDate] = useState('');

  const myQuery = useBuilderMyTasks();
  const scopeQuery = useBuilderScopedTasks(scope);
  const mutation = useBuilderCollaborationMutation();

  const scopeChosen = Boolean(scope.scopeType && scope.scopeId);
  const permissionDenied = (scopeQuery.error as { status?: number } | null)?.status === 403;
  const myTasks = myQuery.data || [];
  const scopeTasks = scopeQuery.data?.records || [];

  const changeStatus = async (task: BuilderTask, status: BuilderTaskStatus) => {
    if (status === task.status) return;
    try {
      await mutation.mutateAsync({
        operation: 'upsert_task', task_id: task.id,
        expected_version: task.row_version, status,
        reason: `Moved to ${TASK_STATUS_LABELS[status]}`,
      });
      toast({ title: `Task moved to ${TASK_STATUS_LABELS[status]}` });
    } catch (error) {
      toast({
        title: 'The task could not be updated',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const createTask = async () => {
    if (!title.trim()) return;
    try {
      await mutation.mutateAsync({
        operation: 'upsert_task',
        scope_type: scope.scopeType, scope_id: scope.scopeId,
        title: title.trim(), description: description.trim() || null,
        priority, due_date: dueDate || null,
      });
      toast({ title: 'Task created' });
      setCreateOpen(false);
      setTitle(''); setDescription(''); setPriority('normal'); setDueDate('');
    } catch (error) {
      toast({
        title: 'The task could not be created',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const overdueCount = myTasks.filter(isTaskOverdue).length;
  const openCount = myTasks.filter((task) => !['done', 'cancelled'].includes(task.status)).length;

  return (
    <BuilderPortalShell
      title="Tasks"
      description="Work assigned to you, and everything outstanding on the records you can reach."
      actions={
        <>
          <Button
            variant="outline" size="sm"
            onClick={() => { void myQuery.refetch(); void scopeQuery.refetch(); }}
            disabled={myQuery.isFetching || scopeQuery.isFetching}
          >
            <RefreshCw
              className={cn('mr-2 h-4 w-4', (myQuery.isFetching || scopeQuery.isFetching) && 'animate-spin')}
              aria-hidden
            />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!scopeChosen}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />New task
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Assigned to me', value: myTasks.length, icon: ListChecks },
          { label: 'Still open', value: openCount, icon: CheckCircle2 },
          { label: 'Overdue', value: overdueCount, icon: AlertTriangle },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-3 pt-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-primary/25 bg-primary/10">
                <Icon className="h-5 w-5 text-primary" aria-hidden />
              </span>
              <div>
                <p className="text-2xl font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="mine">
        <TabsList>
          <TabsTrigger value="mine">Assigned to me</TabsTrigger>
          <TabsTrigger value="record">By record</TabsTrigger>
        </TabsList>

        <TabsContent value="mine" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My tasks</CardTitle>
              <CardDescription>
                Only tasks on records you can still reach appear here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {myQuery.isLoading ? (
                <div className="flex justify-center py-14">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading my tasks" />
                </div>
              ) : myQuery.isError ? (
                <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                  <p className="font-medium">Your tasks could not be loaded</p>
                  <Button className="mt-4" variant="outline" onClick={() => void myQuery.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : !myTasks.length ? (
                <div className="rounded-lg border border-dashed p-10 text-center">
                  <p className="font-medium">Nothing assigned to you</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Tasks assigned to you will appear here.
                  </p>
                </div>
              ) : (
                <TaskTable tasks={myTasks} onStatusChange={changeStatus} busy={mutation.isPending} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="record" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="gap-3">
              <div>
                <CardTitle className="text-base">Choose what to look at</CardTitle>
                <CardDescription>
                  Every option below is one your access already reaches.
                </CardDescription>
              </div>
              <BuilderScopePicker
                value={scope}
                onChange={(next) => patchParams({
                  scope: next.scopeType || null, scopeId: next.scopeId || null,
                })}
                projectId={projectId}
                onProjectChange={(next) => patchParams({ project: next || null })}
              />
            </CardHeader>
            <CardContent>
              {!scopeChosen ? (
                <div className="rounded-lg border border-dashed p-10 text-center">
                  <p className="font-medium">Choose a record to see its tasks</p>
                </div>
              ) : scopeQuery.isLoading ? (
                <div className="flex justify-center py-14">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading tasks" />
                </div>
              ) : permissionDenied ? (
                <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                  <ShieldAlert className="mx-auto h-6 w-6 text-destructive" aria-hidden />
                  <p className="mt-2 font-medium">You do not have access to these tasks</p>
                </div>
              ) : scopeQuery.isError ? (
                <div role="alert" className="rounded-lg border border-destructive/40 p-6 text-center">
                  <p className="font-medium">Tasks could not be loaded</p>
                  <Button className="mt-4" variant="outline" onClick={() => void scopeQuery.refetch()}>
                    Try again
                  </Button>
                </div>
              ) : !scopeTasks.length ? (
                <div className="rounded-lg border border-dashed p-10 text-center">
                  <p className="font-medium">No tasks on this record yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">Create the first one.</p>
                </div>
              ) : (
                <TaskTable tasks={scopeTasks} onStatusChange={changeStatus} busy={mutation.isPending} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              The task belongs to the record selected above.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title" value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Book the frame inspection"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="task-description">Description</Label>
              <Textarea
                id="task-description" value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What needs doing"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="task-priority">Priority</Label>
                <Select
                  value={priority}
                  onValueChange={(next) => setPriority(next as BuilderTaskPriority)}
                >
                  <SelectTrigger id="task-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((value) => (
                      <SelectItem key={value} value={value}>{TASK_PRIORITY_LABELS[value]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="task-due">Due date</Label>
                <Input
                  id="task-due" type="date" value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void createTask()} disabled={!title.trim() || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Create task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BuilderPortalShell>
  );
}
