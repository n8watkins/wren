import { describe, expect, it } from 'vitest'
import { oauthNameOnly } from '../../lib/server/auth'

describe('what a GitHub sign-in may change on an existing user', () => {
  const fromGitHub = { name: 'n8watkins', email: 'other@example.com', emailVerified: true, image: 'https://avatars.example/x.png' }

  it('takes the name and nothing else from the GitHub callback', () => {
    expect(oauthNameOnly(fromGitHub, '/callback/:id')).toEqual({ name: 'n8watkins' })
  })

  it('changes nothing when GitHub sent no name', () => {
    expect(oauthNameOnly({ ...fromGitHub, name: '  ' }, '/callback/:id')).toEqual({})
  })

  it('leaves every other update alone', () => {
    expect(oauthNameOnly(fromGitHub, '/update-user')).toEqual(fromGitHub)
    expect(oauthNameOnly(fromGitHub, undefined)).toEqual(fromGitHub)
  })
})
