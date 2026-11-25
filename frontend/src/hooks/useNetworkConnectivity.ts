/**
 * React hook for network connectivity state.
 * Provides easy access to online/offline status and network operations.
 */

import { useEffect, useState } from "react";
import { networkConnectivityService } from "../services/networkConnectivity";
import { useNetworkStore } from "../store/networkStore";

export function useNetworkConnectivity() {
  const isOnline = useNetworkStore((state) => state.isOnline);
  const hasRecentConnectionFailure = useNetworkStore((state) => state.hasRecentConnectionFailure);
  const [isActuallyOnline, setIsActuallyOnline] = useState(isOnline);
  
  // Initialize network connectivity service on mount
  useEffect(() => {
    networkConnectivityService.initialize();
    
    return () => {
      networkConnectivityService.cleanup();
    };
  }, []);
  
  // Track actual online status with periodic checks
  useEffect(() => {
    let mounted = true;
    
    const checkActualConnectivity = async () => {
      if (!isOnline) {
        setIsActuallyOnline(false);
        return;
      }
      
      // When browser says we're online, verify with an actual check
      const isReachable = await networkConnectivityService.checkNetworkReachable();
      if (mounted) {
        setIsActuallyOnline(isReachable);
      }
    };
    
    checkActualConnectivity();
    
    // Check every 15 seconds when online to detect issues
    const interval = setInterval(checkActualConnectivity, 15000);
    
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [isOnline]);
  
  const shouldBlockOperations = !isActuallyOnline || hasRecentConnectionFailure;
  
  const trackRequest = (id: string, type: string, data?: any) => {
    networkConnectivityService.trackRequest(id, type, data);
  };
  
  const completeRequest = (id: string) => {
    networkConnectivityService.completeRequest(id);
  };
  
  const markRequestFailed = (id: string) => {
    networkConnectivityService.markRequestFailed(id);
  };
  
  const retryFailedRequest = (_id: string, retryFn: () => Promise<void>) => {
    // Clear the failure state before retry
    useNetworkStore.getState().clearConnectionFailure();
    
    // Execute the retry function
    return retryFn();
  };
  
  return {
    // State
    isOnline: isActuallyOnline,
    hasRecentFailure: hasRecentConnectionFailure,
    shouldBlockOperations,
    
    // Actions
    trackRequest,
    completeRequest,
    markRequestFailed,
    retryFailedRequest,
    
    // Utilities
    recordNetworkOperation: () => networkConnectivityService.recordNetworkOperation(),
    getRetryableRequests: () => networkConnectivityService.getRetryableRequests(),
    getStatus: () => networkConnectivityService.getStatus(),
  };
}

/**
 * Hook to automatically block UI actions when offline
 */
export function useNetworkAwareAction<T extends (...args: any[]) => Promise<any>>(
  action: T,
  actionName: string,
  options?: {
    onBlocked?: () => void;
    onNetworkError?: (error: Error) => void;
    onRetry?: () => void;
  }
): T {
  const { shouldBlockOperations, trackRequest, completeRequest, markRequestFailed } = useNetworkConnectivity();
  
  const wrappedAction = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    // Generate unique request ID
    const requestId = `${actionName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Check if we should block the operation
    if (shouldBlockOperations) {
      options?.onBlocked?.();
      throw new Error(`Network connectivity issues detected. Please check your internet connection and try again.`);
    }
    
    try {
      // Track the request
      trackRequest(requestId, actionName, { args });
      
      // Execute the action
      const result = await action(...args);
      
      // Mark as completed
      completeRequest(requestId);
      
      return result;
    } catch (error) {
      // Check if error is a network error
      const isNetworkError = 
        error instanceof TypeError && error.message.includes('fetch') ||
        error instanceof DOMException && error.name === 'NetworkError' ||
        (error instanceof Error && (
          error.message.includes('network') ||
          error.message.includes('Network') ||
          error.message.includes('connection') ||
          error.message.includes('fetch') ||
          error.message.includes('timeout')
        ));
      
      if (isNetworkError) {
        // Mark as failed due to network issues
        markRequestFailed(requestId);
        options?.onNetworkError?.(error as Error);
        
        throw new Error(`Network error: ${error instanceof Error ? error.message : String(error)}. Please check your connection and try again.`);
      }
      
      // Other errors - just complete tracking and re-throw
      completeRequest(requestId);
      throw error;
    }
  };
  
  return wrappedAction as T;
}