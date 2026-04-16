import { LaunchGradientBody } from "../../components/launch/launch-gradient-body";

export default function LaunchLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <LaunchGradientBody />
      {children}
    </>
  );
}
