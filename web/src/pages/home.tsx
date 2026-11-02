import { ActivityGrid } from '@/components/home/activity-grid'
import { Greeting } from '@/components/home/greeting'
import { Limits } from '@/components/home/limits'
import { Now } from '@/components/home/now'
import { RecentProjects } from '@/components/home/recent-projects'
import { TopProjects, UsageCharts, UsageHours } from '@/components/home/usage-charts'
import { useActivity } from '@/lib/activity'

/**
 * A tela inicial: saudação e os painéis (o que pede você, limites, o ano em quadradinhos, os últimos
 * 30 dias, quando você usa e os projetos). No PC, um bento de 12 colunas: linhas de um card largo e um
 * estreito, alternando o lado, e os dois de cada linha com a mesma altura. A saudação alinha com eles.
 */
export function HomePage() {
  const activity = useActivity()
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 pt-[max(1.5rem,var(--safe-top))] pb-10 compact:pt-3">
      <Greeting />
      <div className="grid gap-4 lg:grid-cols-12">
        <Now className="lg:col-span-5" />
        <Limits className="lg:col-span-7" />
        <ActivityGrid days={activity?.days ?? null} className="lg:col-span-12" />
        <UsageCharts activity={activity} className="lg:col-span-7" />
        <UsageHours activity={activity} className="lg:col-span-5" />
        <TopProjects activity={activity} className="lg:col-span-5" />
        <RecentProjects activity={activity} className="lg:col-span-7" />
      </div>
    </div>
  )
}
