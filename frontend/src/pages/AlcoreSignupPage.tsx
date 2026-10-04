/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/store/authStore';
import { AlcoreSignupForm } from '@/components/AlcoreSignupForm';
import { Logo } from '@/components/Logo';
import { LogoMark } from '@/components/LogoMark';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { CelestialSky } from '@/components/CelestialSky';

/**
 * Public signup route (open registration).
 *
 * Renders the Auth-driven signup form outside the workspace shell, like
 * `/login`. Already-authenticated visits bounce home; the form itself
 * lands a new user logged in via register-then-exchange.
 */
export const AlcoreSignupPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, requiresAuth } = useAuthStore();

  React.useEffect(() => {
    if (isAuthenticated || !requiresAuth()) {
      navigate('/');
    }
  }, [isAuthenticated, navigate, requiresAuth]);

  if (isAuthenticated || !requiresAuth()) {
    return null;
  }

  return (
    <div
      className='relative min-h-screen overflow-y-auto bg-canvas text-ink'
      data-celestial-canvas=''
    >
      <CelestialSky />
      <header className='absolute inset-x-0 top-0 z-20 flex h-14 items-center justify-between px-5 sm:px-8'>
        <div className='flex items-center gap-2 text-ink'>
          <LogoMark size='sm' label={null} />
          <span className='hidden sm:inline'>
            <Logo size='sm' />
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <LanguageSwitcher compact />
          <ThemeToggle />
        </div>
      </header>

      <main className='relative z-10 flex min-h-screen items-center justify-center px-5 pb-12 pt-24 sm:px-8'>
        <AlcoreSignupForm />
      </main>
    </div>
  );
};

export default AlcoreSignupPage;
