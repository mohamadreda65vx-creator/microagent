import { Hourglass } from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { PLANNED_COPY } from '../../components/layout/nav';
import { Card, EmptyState } from '../../components/ui/primitives';

/** Sections that belong to later phases. They show an honest empty state: no fake data. */
export default function Planned() {
  const key = useLocation().pathname.split('/').pop() ?? '';
  const copy = PLANNED_COPY[key];
  if (!copy) return <Navigate to="/app" replace />;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-mist-900">{copy.title}</h2>
      </div>
      <Card>
        <EmptyState icon={Hourglass} title="Coming in a later phase" description={copy.description} />
      </Card>
    </div>
  );
}
