import { Topbar } from '@/components/Topbar';

export default function NotFoundPage() {
  return (
    <>
      <Topbar crumb="Not found" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/404</div>
            <h1 className="head__title">
              No <em>such</em> page.
            </h1>
            <p className="head__lede">The route you followed does not exist on this server.</p>
          </div>
        </div>
      </section>
    </>
  );
}
