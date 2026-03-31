import { useState, useEffect } from 'react';

function isViewportBelow(threshold: number) {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < threshold;
}

const useViewport = (threshold = 1024) => {
  const [isSmallViewport, setIsSmallViewport] = useState(() => isViewportBelow(threshold));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => setIsSmallViewport(isViewportBelow(threshold));

    handleResize();
    window.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('resize', handleResize);
    };
  }, [threshold]);

  return isSmallViewport;
};

export default useViewport;
